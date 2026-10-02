import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeBinaryReference } from "../src/binary-materialize.js";
import { createBinaryExport, serveBinaryExport } from "../src/binary-export.js";
import { generateOperationSecret } from "../src/operation-token.js";

const origin = "https://connector.example.com";
const fixtures = [
  ["Large résumé — 文書.pdf", "application/pdf", 25 * 1024 * 1024, "%PDF-1.7\n"],
  ["Image sample.png", "image/png", 2048, "\x89PNG\r\n"],
  ["Reading — étude.epub", "application/epub+zip", 505201, "PK\x03\x04"],
  ["Office notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 1048576, "PK\x03\x04"],
  ["Archive 資料.zip", "application/zip", 2097152, "PK\x03\x04"],
] as const;

// Transport fixtures, not format-parser fixtures. Large content is generated
// lazily; neither endpoint nor the host bridge buffers the complete payload.
function fixture(size: number, prefix: string) {
  const header = Buffer.from(prefix, "latin1");
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === size) { controller.close(); return; }
    const chunk = new Uint8Array(Math.min(65536, size - offset));
    if (offset === 0) chunk.set(header);
    offset += chunk.length; controller.enqueue(chunk);
  } });
}
async function digest(stream: AsyncIterable<Uint8Array>) {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of stream) { bytes += chunk.length; hash.update(chunk); }
  return { size_bytes: bytes, sha256: hash.digest("hex") };
}

for (const [name, mime, size, prefix] of fixtures) test(`reference endpoint → verified local consumer: ${name}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "kdrive-test-"));
  try {
    const secret = generateOperationSecret();
    const original = await digest(fixture(size, prefix));
    const ref = await createBinaryExport(secret, origin, "owner", 42,
      { id: 7, name, type: "file", mime_type: mime }, "pinned-etag", original);
    assert.ok(JSON.stringify(ref).length < 4096);
    const file = await materializeBinaryReference(ref, { origin, directory, fetcher: async (url, init) => {
      assert.equal(init?.redirect, "error");
      return serveBinaryExport(new Request(url, { signal: init?.signal }), new URL(String(url)).pathname.slice(8), {
        secret, subject: "owner", driveId: 42, client: { downloadVersionStream: async (_drive, id, version) => {
          assert.equal(id, 7); assert.equal(version, "pinned-etag");
          return new Response(fixture(size, prefix));
        } },
      });
    } });
    assert.equal(file.file_name, name); assert.equal(file.mime_type, mime);
    assert.equal(file.resolved_version, "pinned-etag");
    assert.equal((await stat(file.local_path)).mode & 0o777, 0o600);
    assert.deepEqual(await digest(createReadStream(file.local_path)), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("expired references refresh explicitly; interrupted/corrupt downloads publish no file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kdrive-test-"));
  try {
    const secret = generateOperationSecret();
    const original = await digest(fixture(1024, "PDF"));
    const ref = await createBinaryExport(secret, origin, "owner", 42, { id: 7, name: "file.pdf", type: "file" }, "v1", original);
    let fetched = false;
    await assert.rejects(() => materializeBinaryReference({ ...ref, expires_at: new Date(0).toISOString() }, {
      origin, directory, fetcher: async () => { fetched = true; return new Response(); },
    }), /kdrive_export_file again/);
    assert.equal(fetched, false);
    for (const response of [
      () => new Response(null, { status: 410 }),
      () => new Response(new Uint8Array(1024)),
      () => new Response(new Uint8Array(1023)),
      () => new Response(new Uint8Array(1025)),
      () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); c.error(new Error("PRIVATE_SOURCE_CREDENTIAL")); } })),
    ]) {
      await assert.rejects(() => materializeBinaryReference(ref, { origin, directory, fetcher: async () => response() }), (error: Error) => {
        assert.doesNotMatch(error.message, /PRIVATE_SOURCE_CREDENTIAL|https:/); return true;
      });
      assert.deepEqual(await readdir(directory), []);
    }
    // Refresh is a new export, not an in-place extension of the old capability.
    const fresh = await createBinaryExport(secret, origin, "owner", 42, { id: 7, name: "file.pdf", type: "file" }, "v2", original);
    const result = await materializeBinaryReference(fresh, { origin, directory, fetcher: async () => new Response(fixture(1024, "PDF")) });
    assert.equal(result.resolved_version, "v2");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("local materializer rejects path traversal and foreign download origins", async () => {
  const secret = generateOperationSecret();
  const ref = await createBinaryExport(secret, origin, "owner", 42, { id: 7, name: "ok.png", type: "file" }, "v1", await digest(fixture(100, "PNG")));
  for (const changed of [{ file_name: "../escape" }, { file_name: "C:\\escape" }, { download_url: "https://evil.example/binary/token" }]) {
    await assert.rejects(() => materializeBinaryReference({ ...ref, ...changed }, { origin }), /Invalid binary reference/);
  }
});

test("aborting a stalled local download cancels its source and removes the partial file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kdrive-test-"));
  try {
    const ref = await createBinaryExport(generateOperationSecret(), origin, "owner", 42,
      { id: 7, name: "file.pdf", type: "file" }, "v1", await digest(fixture(100, "PDF")));
    const controller = new AbortController();
    let cancelled = false;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const result = materializeBinaryReference(ref, { origin, directory, signal: controller.signal, fetcher: async () => {
      started();
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    } });
    await ready;
    controller.abort();
    await assert.rejects(() => result, /interrupted/);
    assert.equal(cancelled, true);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
