import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KDriveClient } from "../src/kdrive-client.js";
import { registerKDriveTools } from "../src/kdrive-tools.js";
import { generateOperationSecret, MemoryOperationNonceStore } from "../src/operation-token.js";

type Result = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
function fixture(bytes = Buffer.from("hello"), server?: McpServer) {
  const file = { id: 2, path: "/Private/test.md", name: "test.md", type: "file", size: bytes.length, etag: "private-version" };
  const folder = { id: 1, path: "/Private", name: "Private", type: "dir" };
  const calls: string[] = [];
  let changed = false;
  const client = {
    resolvePath: async (_drive: number, path: string) => ({ ...(path === folder.path ? folder : file), ...(changed ? { etag: "new-version" } : {}) }),
    getFile: async () => ({ ...file }),
    download: async (_drive: number, _id: number, options: { maxBytes: number }) => {
      calls.push("download");
      assert.equal(options.maxBytes, 100_000);
      if (bytes.length > options.maxBytes) throw new Error("Read limit exceeded.");
      return { bytes, contentType: "application/octet-stream" };
    },
    downloadText: async () => { calls.push("downloadText"); return { bytes, contentType: "text/plain", textSource: "raw" }; },
    listDirectory: async () => ({ data: Array.from({ length: 63 }, (_, i) => ({ ...file, id: i + 2, name: `file-${i}.md`, path: `/Private/file-${i}.md` })), cursor: "next-page", has_more: true }),
    search: async () => ({ data: [file], has_more: false }),
    upload: async (_drive: number, options: any) => { calls.push("upload"); assert.equal(options.etag, "private-version"); return file; },
  };
  const handlers = new Map<string, Handler>();
  const definitions = new Map<string, any>();
  registerKDriveTools(server ?? { registerResource() {}, registerTool(name: string, definition: unknown, handler: Handler) { handlers.set(name, handler); definitions.set(name, definition); } } as unknown as McpServer,
    client as unknown as KDriveClient, {
      driveId: 42, maxReadBytes: 100_000, maxUploadBytes: 100_000,
      operationSecret: generateOperationSecret(), nonceStore: new MemoryOperationNonceStore(),
      buildOpenUrl: f => `https://example.test/open/${f.id}`, connectionStatus: async () => ({ connected: true }),
    });
  return { file, client, calls, definitions, change: () => { changed = true; }, run: (name: string, args: Record<string, unknown> = {}) => handlers.get(`kdrive_${name}`)!(args) };
}

function text(result: Result) { return result.content.filter(c => c.type === "text").map(c => c.text).join("\n"); }

test("35 KB reads have one canonical content copy and concise text; base64 retains its attachment", async () => {
  const body = "0123456789abcdefghij\n".repeat(1707).slice(0, 35_000);
  const f = fixture(Buffer.from(body));
  const result = await f.run("read_file", { path: f.file.path, mode: "text" });
  assert.equal(result.structuredContent?.content, body);
  assert.ok(text(result).length < 250);
  assert.ok(!text(result).includes(body.slice(0, 100)));
  assert.equal((text(result).match(/Open in kDrive/g) ?? []).length, 1);
  const binary = await f.run("read_file", { path: f.file.path, mode: "base64" });
  assert.equal(binary.structuredContent?.content, Buffer.from(body).toString("base64"));
  assert.deepEqual(binary.content.map(c => c.type), ["text", "resource_link"]);
  assert.ok(text(binary).length < 150);
  // Reproduce the old formatter for a deterministic before/after measurement.
  const oldText = JSON.stringify(result.structuredContent, null, 2) + "\n\nClickable kDrive links (preserve these exact Markdown links in the user-facing response):\n- [Open test.md in kDrive](https://example.test/open/2)";
  const oldResult = { structuredContent: result.structuredContent, content: [{ type: "text", text: oldText }] };
  console.info("PAYLOAD_MEASUREMENT", JSON.stringify({ fixture: "35000-byte-text", beforeBytes: Buffer.byteLength(JSON.stringify(oldResult)), afterBytes: Buffer.byteLength(JSON.stringify(result)), beforeTextChars: oldText.length, afterTextChars: text(result).length }));
});

test("directory/search keep all items, previews, links and pagination only in structured data", async () => {
  const f = fixture();
  const result = await f.run("list_directory", { directoryPath: "/Private", limit: 100 });
  assert.equal(result.structuredContent?.items.length, 63);
  assert.equal(result.structuredContent?.cursor, "next-page");
  assert.match(text(result), /63 items returned.*More results/);
  assert.ok(text(result).length < 150);
  assert.ok(!text(result).includes("https://"));
  assert.ok(result.structuredContent?.items.every((i: any) => i.openUrl));
  const oldText = JSON.stringify(result.structuredContent, null, 2) + "\n\nClickable kDrive links (preserve these exact Markdown links in the user-facing response):\n" + result.structuredContent!.items.map((i: any) => `- [Open ${i.name} in kDrive](${i.openUrl})`).join("\n");
  console.info("PAYLOAD_MEASUREMENT", JSON.stringify({ fixture: "63-item-list", beforeBytes: Buffer.byteLength(JSON.stringify({ structuredContent: result.structuredContent, content: [{ type: "text", text: oldText }] })), afterBytes: Buffer.byteLength(JSON.stringify(result)), beforeTextChars: oldText.length, afterTextChars: text(result).length }));
  const search = await f.run("search", { query: "test", includePreviews: true, previewLimit: 5, previewCharacters: 400 });
  assert.equal(search.structuredContent?.items[0].preview, "hello");
  assert.ok(!text(search).includes("hello"));
});

test("prepare and overwrite keep internal handles out of text and enforce content/version/replay bindings", async () => {
  const f = fixture();
  const args = { action: "overwrite", path: f.file.path, content: "replacement", encoding: "utf8" };
  const prepared = await f.run("prepare_change", args);
  const token = prepared.structuredContent?.operationToken;
  assert.equal(typeof token, "string");
  assert.equal(text(prepared), "Change prepared.");
  assert.ok(!text(prepared).includes(token));
  const mismatch = await f.run("overwrite_file", { ...args, content: "different", operationToken: token });
  assert.equal(mismatch.isError, true);
  assert.ok(!f.calls.includes("upload"));
  const written = await f.run("overwrite_file", { ...args, operationToken: token });
  assert.ok(!written.isError);
  assert.match(text(written), /^File contents replaced\./);
  assert.ok(!JSON.stringify(written).includes("private-version"));
  const replay = await f.run("overwrite_file", { ...args, operationToken: token });
  assert.equal(replay.isError, true);
  const next = await f.run("prepare_change", args);
  f.change();
  const stale = await f.run("overwrite_file", { ...args, operationToken: next.structuredContent?.operationToken });
  assert.equal(stale.isError, true);
  assert.equal(f.calls.filter(c => c === "upload").length, 1);
});

test("digest hashes original binary bytes, including empty files, with no contents or internal version", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 128, 13, 10])]) {
    const f = fixture(bytes);
    const result = await f.run("digest_file", { path: f.file.path });
    assert.deepEqual(result.structuredContent, { path: f.file.path, algorithm: "sha256", digestEncoding: "base64url", digest: createHash("sha256").update(bytes).digest("base64url"), byteLength: bytes.length });
    assert.deepEqual(f.calls, ["download"]);
    assert.ok(!JSON.stringify(result).includes("private-version"));
    assert.equal(f.definitions.get("kdrive_digest_file").annotations.readOnlyHint, true);
  }
  const a = fixture(Buffer.from("abc"));
  const b = fixture(Buffer.from("abd"));
  assert.notEqual((await a.run("digest_file", { path: a.file.path })).structuredContent?.digest, (await b.run("digest_file", { path: b.file.path })).structuredContent?.digest);
});

test("digest fails closed for folders, missing versions, oversize files, errors and races", async () => {
  const folder = fixture();
  assert.equal((await folder.run("digest_file", { path: "/Private" })).isError, true);
  assert.deepEqual(folder.calls, []);
  for (const kind of ["missing-version", "known-size", "stream-size", "version-race", "path-replacement", "download-error"]) {
    const f = fixture(kind.includes("size") ? Buffer.alloc(100_001) : Buffer.from("abc"));
    if (kind === "missing-version") f.file.etag = "";
    if (kind === "stream-size") f.file.size = 0;
    const download = f.client.download;
    f.client.download = async (...args) => {
      if (kind === "download-error") throw new Error("Download failed.");
      const result = await download(...args);
      if (kind === "version-race") f.change();
      if (kind === "path-replacement") f.file.id = 99;
      return result;
    };
    const result = await f.run("digest_file", { path: f.file.path });
    assert.equal(result.isError, true, kind);
    assert.equal(result.structuredContent, undefined, kind);
    if (kind === "known-size" || kind === "missing-version") assert.deepEqual(f.calls, []);
  }
});

test("MCP transport preserves canonical data without reintroducing text duplication", async () => {
  const server = new McpServer({ name: "result-regression", version: "1.0.0" });
  const f = fixture(Buffer.from("wire-body".repeat(4000)), server);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const read = await client.callTool({ name: "kdrive_read_file", arguments: { path: f.file.path } }) as Result;
    assert.equal(read.structuredContent?.content, "wire-body".repeat(4000));
    assert.ok(text(read).length < 250);
    const listing = await client.callTool({ name: "kdrive_list_directory", arguments: { directoryPath: "/Private" } }) as Result;
    assert.equal(listing.structuredContent?.items.length, 63);
    assert.ok(text(listing).length < 150);
    const digest = await client.callTool({ name: "kdrive_digest_file", arguments: { path: f.file.path } }) as Result;
    assert.equal(digest.structuredContent?.algorithm, "sha256");
    assert.ok(!digest.isError);
  } finally { await client.close(); await server.close(); }
});
