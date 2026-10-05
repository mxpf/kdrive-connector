import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BinaryDigestCache } from "../src/binary-digest-cache.js";
import { registerBinaryTools } from "../src/binary-tools.js";
import { KDriveClient } from "../src/kdrive-client.js";
import { loadConfig } from "../src/config.js";
import { createBinaryExport, serveBinaryExport } from "../src/binary-export.js";
import { generateOperationSecret } from "../src/operation-token.js";

const identity = { driveId: 42, fileId: 7, versionId: "v1", size: 3 };
const digest = { size_bytes: 3, sha256: "a".repeat(64) };

test("digest cache expires absolutely, promotes LRU, and never aliases mutable values", () => {
  let now = 0;
  const cache = new BinaryDigestCache(2, 100, () => now);
  cache.set(identity, digest);
  cache.set({ ...identity, fileId: 8 }, digest);
  now = 50;
  const found = cache.get(identity)!;
  found.sha256 = "b".repeat(64);
  assert.equal(cache.get(identity)!.sha256, digest.sha256);
  cache.set({ ...identity, fileId: 9 }, digest);
  assert.equal(cache.get({ ...identity, fileId: 8 }), undefined);
  assert.ok(cache.get(identity));
  now = 100;
  assert.equal(cache.get(identity), undefined); // reads did not renew its TTL
  assert.ok(cache.get({ ...identity, fileId: 9 }));
  now = 150;
  assert.equal(cache.get({ ...identity, fileId: 9 }), undefined);
});

test("digest cache keys include drive, file ID, version type/value and size", () => {
  const cache = new BinaryDigestCache();
  cache.set({ ...identity, versionId: 1 }, digest);
  for (const changed of [{ driveId: 43 }, { fileId: 8 }, { versionId: "1" }, { versionId: 2 }, { size: 4 }]) {
    assert.equal(cache.get({ ...identity, versionId: 1, ...changed }), undefined);
  }
  assert.throws(() => cache.set(identity, { ...digest, size_bytes: 4 }));
  assert.throws(() => cache.set(identity, { ...digest, sha256: "invalid" }));
});

function harness(size = 3) {
  const state = { id: 7, version: "v1", size, name: "document.pdf", mime: "application/pdf",
    denied: false, failRead: false, drift: false, corrupt: false, reads: 0, metadata: 0, transferred: 0 };
  const secret = generateOperationSecret();
  const origin = "https://connector.example.com";
  const file = () => ({ id: state.id, type: "file", name: state.name, etag: state.version, size: state.size, mime_type: state.mime });
  const client = new KDriveClient(loadConfig({ INFOMANIAK_DRIVE_ID: "42" }), { getAccessToken: async () => "test" }, async (url) => {
    if (String(url).includes("/download")) {
      state.reads++;
      let offset = 0;
      const length = state.size;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (state.failRead) { controller.error(new Error("Interrupted")); return; }
        if (offset === length) {
          if (state.drift) state.version = "changed-mid-stream";
          controller.close(); return;
        }
        const chunk = new Uint8Array(Math.min(65536, length - offset)).fill(state.corrupt ? 2 : 1);
        offset += chunk.length; state.transferred += chunk.length;
        controller.enqueue(chunk);
      } }));
    }
    state.metadata++;
    return state.denied ? Response.json({ result: "error" }, { status: 403 }) : Response.json({ result: "success", data: file() });
  });
  // Only path traversal is stubbed; real before/after version checks remain active.
  client.resolvePath = async () => file();
  function register(subject = "owner") {
    let handler!: (input: { path: string }) => Promise<any>;
    const server = { registerTool(name: string, _config: unknown, fn: typeof handler) { if (name === "kdrive_export_file") handler = fn; } } as unknown as Pick<McpServer, "registerTool">;
    registerBinaryTools(server, client, { driveId: 42, buildOpenUrl: () => "unused",
      buildBinaryExport: (f, version, d) => createBinaryExport(secret, origin, subject, 42, f, version, d) });
    return () => handler({ path: "/Private/document.pdf" });
  }
  const download = (ref: any) => serveBinaryExport(new Request(ref.download_url), new URL(ref.download_url).pathname.slice(8), { secret, subject: "owner", driveId: 42, client });
  return { state, exportFile: register(), register, download };
}

test("25 MiB warm export avoids one full provider read; delivery still reads and verifies bytes", async (t) => {
  const events: any[] = [];
  t.mock.method(console, "error", (line: string) => events.push(JSON.parse(line)));
  const h = harness(25 * 1024 * 1024);
  const first = await h.exportFile();
  assert.equal(first.isError, undefined);
  const metadata = h.state.metadata;
  const second = await h.exportFile();
  assert.equal(second.isError, undefined);
  assert.equal(h.state.reads, 1);
  assert.equal(h.state.transferred, h.state.size);
  assert.ok(h.state.metadata > metadata);
  assert.equal(first.structuredContent.sha256, second.structuredContent.sha256);
  assert.notEqual(first.structuredContent.trace_id, second.structuredContent.trace_id);
  assert.notEqual(first.structuredContent.download_url, second.structuredContent.download_url);
  assert.ok(events.some(e => e.digestCacheHit === true && e.avoidedDownloadBytes === h.state.size));
  const response = await h.download(second.structuredContent);
  let count = 0;
  for await (const chunk of response.body!) count += chunk.length;
  assert.equal(count, h.state.size);
  assert.equal(h.state.reads, 2); // cold export + delivery, not cold + warm + delivery
  assert.equal(h.state.transferred, h.state.size * 2);
});

test("warm exports still require current permission and return fresh presentation metadata", async () => {
  const h = harness();
  await h.exportFile();
  h.state.denied = true;
  assert.equal((await h.exportFile()).isError, true);
  assert.equal(h.state.reads, 1);
  h.state.denied = false;
  h.state.name = "renamed.pdf";
  const renewed = await h.exportFile();
  assert.equal(renewed.structuredContent.file_name, "renamed.pdf");
  assert.equal(h.state.reads, 1);
});

test("changed ETag, size, replacement file ID, and another registration never reuse the digest", async () => {
  const h = harness();
  await h.exportFile();
  h.state.version = "v2";
  await h.exportFile();
  h.state.size++;
  await h.exportFile();
  h.state.id++;
  await h.exportFile();
  await h.register("another-owner")();
  assert.equal(h.state.reads, 5);
});

for (const failure of ["failRead", "drift"] as const) test(`${failure} never populates the verified cache`, async () => {
  const h = harness();
  h.state[failure] = true;
  assert.equal((await h.exportFile()).isError, true);
  h.state[failure] = false;
  h.state.version = "v1";
  assert.equal((await h.exportFile()).isError, undefined);
  assert.equal(h.state.reads, 2);
});

test("cached references still reject version drift and same-size byte corruption on delivery", async () => {
  const h = harness();
  await h.exportFile();
  const ref = (await h.exportFile()).structuredContent;
  h.state.version = "v2";
  assert.equal((await h.download(ref)).status, 409);
  h.state.version = "v1";
  h.state.corrupt = true;
  const response = await h.download(ref);
  await assert.rejects(() => response.arrayBuffer(), /integrity/);
});
