import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { KDriveClient } from "../src/kdrive-client.js";
import { extractPdf, PDF_LIMITS } from "../src/pdf-extract.js";
import { readKDrivePdf, registerPdfTools } from "../src/pdf-tools.js";
import { BinaryTransferError } from "../src/binary-transport.js";

const ordinary = new Uint8Array(await readFile(new URL("./fixtures/pdf/ordinary.pdf", import.meta.url)));
const protectedPdf = new Uint8Array(await readFile(new URL("./fixtures/pdf/password-protected.pdf", import.meta.url)));
const hash = createHash("sha256").update(ordinary).digest("hex");
const code = (expected: string) => (e: any) => { assert.equal(e.code, expected); return true; };

// Tiny generated test documents exercise page boundaries, Flate streams and an
// image-only page. No user documents or external fixture downloads are involved.
function syntheticPdf(contents: string[], image = false) {
  const imageId = 4 + contents.length * 2;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Count ${contents.length} /Kids [${contents.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (const [i, content] of contents.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${image ? `/XObject << /Im0 ${imageId} 0 R >>` : ""} >> /Contents ${5 + i * 2} 0 R >>`);
    const stream = deflateSync(Buffer.from(content, "latin1")).toString("latin1");
    objects.push(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n${stream}\nendstream`);
  }
  if (image) objects.push("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nX\nendstream");
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}
function client(bytes = ordinary) {
  return {
    resolveBinaryVersion: async () => ({ file: { id: 7, name: "fixture.pdf", type: "file", size: bytes.length }, versionId: "v1" }),
    downloadVersionStream: async () => new Response(bytes),
  };
}

test("direct PDF reads return verified bytes, bounded page text and clear limitations", async () => {
  const result = await readKDrivePdf(client(), 42, { path: "/Private/fixture.pdf" });
  assert.equal(result.sha256, hash);
  assert.equal(result.byteLength, ordinary.length);
  assert.equal(result.totalPages, 1);
  assert.equal(result.pages[0].page, 1);
  assert.equal(result.pages[0].status, "text");
  assert.match(result.pages[0].text, /ORCHID-7319/);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextPage, null);
  assert.match(result.warnings.join(" "), /not visually verified/);
});

test("encrypted PDFs distinguish missing and wrong passwords, and extract with authorized password", async () => {
  await assert.rejects(extractPdf(protectedPdf.slice()), code("PDF_PASSWORD_REQUIRED"));
  await assert.rejects(extractPdf(protectedPdf.slice(), { password: "private-wrong-password" }), e => {
    assert.ok(code("PDF_PASSWORD_INCORRECT")(e));
    assert.ok(!String(e).includes("private-wrong-password")); return true;
  });
  const result = await extractPdf(protectedPdf.slice(), { password: "synthetic-open-password" });
  assert.match(result.pages[0].text, /ORCHID-7319/);
  assert.ok(!JSON.stringify(result).includes("synthetic-open-password"));
});

test("range, size and malformed PDF errors never return partial content", async () => {
  await assert.rejects(extractPdf(ordinary.slice(), { startPage: 2 }), code("PDF_PAGE_RANGE"));
  await assert.rejects(extractPdf(ordinary.slice(), { pageCount: 6 }), code("PDF_PAGE_RANGE"));
  await assert.rejects(extractPdf(new Uint8Array(PDF_LIMITS.bytes + 1)), code("PDF_SIZE_LIMIT"));
  await assert.rejects(extractPdf(new TextEncoder().encode("private-not-pdf")), code("PDF_INVALID"));
  await assert.rejects(extractPdf(new TextEncoder().encode("%PDF-1.7 private-broken-content")), e => {
    assert.ok(code("PDF_PARSE_FAILED")(e)); assert.ok(!String(e).includes("private-broken-content")); return true;
  });
});

test("compressed multi-page PDFs paginate without losing or mixing pages", async () => {
  const bytes = syntheticPdf(Array.from({ length: 7 }, (_, i) => `BT /F1 12 Tf 50 700 Td (SYNTHETIC-PAGE-${i + 1}) Tj ET`));
  const first = await readKDrivePdf(client(bytes), 42, { path: "/Private/pages.pdf" });
  assert.deepEqual(first.pages.map(p => p.page), [1, 2, 3, 4, 5]);
  assert.equal(first.nextPage, 6); assert.equal(first.hasMore, true);
  const second = await readKDrivePdf(client(bytes), 42, { path: "/Private/pages.pdf", startPage: 6, expectedSha256: first.sha256 });
  assert.deepEqual(second.pages.map(p => p.page), [6, 7]);
  assert.match(second.pages[1].text, /SYNTHETIC-PAGE-7/);
  assert.equal(second.nextPage, null); assert.equal(second.hasMore, false);
});

test("image-only PDFs report no text and need for OCR rather than fabricated extraction", async () => {
  const result = await extractPdf(syntheticPdf(["q 100 0 0 100 50 500 cm /Im0 Do Q"], true));
  assert.equal(result.pages[0].text, "");
  assert.equal(result.pages[0].status, "no_text");
  assert.match(result.warnings.join(" "), /no OCR was performed/);
});

test("document page and output limits reject excess data; aborted parsing stops", async () => {
  await assert.rejects(extractPdf(syntheticPdf(Array(201).fill(""))), code("PDF_PAGE_LIMIT"));
  await assert.rejects(extractPdf(syntheticPdf([Array(2501).fill(`BT /F1 12 Tf 50 700 Td (${"X".repeat(40)}) Tj ET`).join("\n")])), code("PDF_OUTPUT_LIMIT"));
  await assert.rejects(extractPdf(ordinary.slice(), {}, AbortSignal.abort()));
});

test("download length, final version checks and continuation hashes fail closed", async () => {
  const short = client(); short.downloadVersionStream = async () => new Response(ordinary.slice(0, -1));
  await assert.rejects(readKDrivePdf(short, 42, { path: "/Private/test.pdf" }), code("PDF_INTEGRITY_MISMATCH"));
  const long = client(); long.downloadVersionStream = async () => new Response(new Uint8Array(ordinary.length + 1));
  await assert.rejects(readKDrivePdf(long, 42, { path: "/Private/test.pdf" }), code("PDF_INTEGRITY_MISMATCH"));
  await assert.rejects(readKDrivePdf(client(), 42, { path: "/Private/test.pdf", expectedSha256: "0".repeat(64) }), code("PDF_INTEGRITY_MISMATCH"));
  const changed = client();
  changed.downloadVersionStream = async () => new Response(new ReadableStream({ start(c) { c.enqueue(ordinary); }, pull(c) { c.error(new BinaryTransferError("secret-provider-message", "VERSION_CHANGED")); } }));
  await assert.rejects(readKDrivePdf(changed, 42, { path: "/Private/test.pdf" }), code("PDF_VERSION_CHANGED"));
});

test("metadata size rejection occurs before download and parallel extraction is rejected", async () => {
  let downloads = 0;
  const large = client();
  large.resolveBinaryVersion = async () => ({ file: { id: 7, name: "large.pdf", type: "file", size: PDF_LIMITS.bytes + 1 }, versionId: "v1" });
  large.downloadVersionStream = async () => { downloads++; return new Response(ordinary); };
  await assert.rejects(readKDrivePdf(large, 42, { path: "/Private/large.pdf" }), code("PDF_SIZE_LIMIT"));
  assert.equal(downloads, 0);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const slow = client(); slow.downloadVersionStream = async () => { await gate; return new Response(ordinary); };
  const first = readKDrivePdf(slow, 42, { path: "/Private/test.pdf" });
  await assert.rejects(readKDrivePdf(client(), 42, { path: "/Private/test.pdf" }), code("PDF_BUSY"));
  release(); await first;
  assert.equal((await readKDrivePdf(client(), 42, { path: "/Private/test.pdf" })).sha256, hash);
});

test("MCP exposes direct PDF reading and returns text without a resource or Adobe file", async () => {
  const server = new McpServer({ name: "pdf-test", version: "1" });
  registerPdfTools(server, client() as unknown as KDriveClient, 42);
  const host = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await host.connect(b);
  try {
    const tools = await host.listTools();
    assert.equal(tools.tools[0].name, "kdrive_read_pdf");
    assert.equal(tools.tools[0].annotations?.readOnlyHint, true);
    const result = await host.callTool({ name: "kdrive_read_pdf", arguments: { path: "/Private/fixture.pdf" } });
    assert.ok(!result.isError);
    assert.match(JSON.stringify(result.structuredContent), /ORCHID-7319/);
    assert.ok(!JSON.stringify(result).includes("download_url"));
    const error = await host.callTool({ name: "kdrive_read_pdf", arguments: { path: "/Private/fixture.pdf", startPage: 2 } });
    assert.equal(error.isError, true);
    assert.equal(error.structuredContent?.error_code, "PDF_PAGE_RANGE");
  } finally { await host.close(); await server.close(); }
});
