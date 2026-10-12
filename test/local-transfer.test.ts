import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, stat, symlink, open, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { uploadLocalFile, downloadLocalFile, verifyLocalTransfer, LOCAL_MAX_BYTES, LocalTransferError } from "../src/local-transfer.js";
import { hashBinary, BinaryTransferError } from "../src/binary-transport.js";

const bytes = Buffer.from("local binary fixture\x00\xff");
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const options = () => ({ signal: AbortSignal.timeout(30_000) });
function harness(data = bytes) {
  let calls = 0;
  let uploads = 0;
  let downloads = 0;
  const file = { id: 99, name: "Unicode — 文件.zip", type: "file", size: data.length, etag: "v1", mime_type: "application/zip" };
  const client = {
    async resolvePath() { return { id: 7, name: "folder", type: "dir" }; },
    async resolveBinaryVersion() { calls++; return { file, versionId: file.etag }; },
    async downloadVersionStream(_drive: number, id: number, version: string | number) {
      assert.equal(id, file.id); assert.equal(version, "v1"); downloads++;
      return new Response(data);
    },
    async uploadBinary(_drive: number, input: { body: ReadableStream<Uint8Array>; fileName: string; size: number; expectedSha256?: string; signal: AbortSignal }) {
      uploads++;
      file.name = input.fileName;
      const digest = await hashBinary(input.body, input.size, input.signal);
      assert.equal(digest.sha256, input.expectedSha256);
      return { file, ...digest };
    },
  };
  return { client, file, counts: () => ({ calls, uploads, downloads }) };
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kdrive-local-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.zip");
  await writeFile(source, bytes);
  return { directory, source };
}

test("local upload independently downloads the committed ID and checks source SHA-256", async t => {
  const { source } = await fixture(t);
  const h = harness();
  const result = await uploadLocalFile(h.client, 42, source, "/Private/Unicode — 文件.zip", options());
  assert.equal(result.verified, true); assert.equal(result.sha256, sha(bytes));
  assert.equal(result.version_id, "v1");
  assert.deepEqual(h.counts(), { calls: 1, uploads: 1, downloads: 1 });
  assert.deepEqual(await readFile(source), bytes);
});

test("uploads read the private snapshot even if the original changes after snapshotting", async t => {
  const { source } = await fixture(t);
  const h = harness();
  h.client.resolvePath = async () => { await writeFile(source, "changed"); return { id: 7, name: "folder", type: "dir" }; };
  const result = await uploadLocalFile(h.client, 42, source, "/Private/a.zip", options());
  assert.equal(result.sha256, sha(bytes));
});

test("bad expected checksums, sizes and symlinks fail before uploading", async t => {
  const { source, directory } = await fixture(t);
  const h = harness();
  for (const extra of [{ expectedSha256: "0".repeat(64) }, { expectedSize: 1 }, { expectedSha256: "bad" }]) {
    await assert.rejects(uploadLocalFile(h.client, 42, source, "/Private/a.zip", { ...options(), ...extra }));
  }
  const link = path.join(directory, "link"); await symlink(source, link);
  await assert.rejects(uploadLocalFile(h.client, 42, link, "/Private/a.zip", options()));
  assert.equal(h.counts().uploads, 0);
});

test("readback corruption, replacement and failure retain an unverified receipt, never retry upload", async t => {
  const { source } = await fixture(t);
  for (const failure of ["corrupt", "replacement", "transport"]) {
    const h = harness();
    if (failure === "corrupt") h.client.downloadVersionStream = async () => new Response(Buffer.alloc(bytes.length));
    if (failure === "transport") h.client.downloadVersionStream = async () => { throw new Error("secret signed URL"); };
    if (failure === "replacement") h.client.resolveBinaryVersion = async () => ({ file: { ...h.file, id: 100 }, versionId: "v1" });
    await assert.rejects(uploadLocalFile(h.client, 42, source, "/Private/a.zip", options()), (error: unknown) => {
      assert.ok(error instanceof LocalTransferError);
      assert.equal(error.code, "UPLOADED_NOT_VERIFIED");
      assert.equal(error.receipt?.file_id, 99); assert.equal(error.receipt?.verified, false);
      assert.ok(!JSON.stringify(error).includes("secret")); return true;
    });
    assert.equal(h.counts().uploads, 1);
  }
});

test("destination conflict propagates without retry or verification", async t => {
  const { source } = await fixture(t); const h = harness(); let attempts = 0;
  h.client.uploadBinary = async () => { attempts++; throw new BinaryTransferError("conflict", "DESTINATION_CONFLICT"); };
  await assert.rejects(uploadLocalFile(h.client, 42, source, "/Private/a.zip", options()), { code: "DESTINATION_CONFLICT" });
  assert.equal(attempts, 1); assert.equal(h.counts().downloads, 0);
});

test("download returns a private local file with Unicode name, correct size and digest", async t => {
  const h = harness();
  const result = await downloadLocalFile(h.client, 42, "/Private/Unicode — 文件.zip", { ...options(), expectedSha256: sha(bytes) });
  t.after(() => rm(path.dirname(result.local_path), { recursive: true, force: true }));
  assert.deepEqual(await readFile(result.local_path), bytes);
  assert.equal((await stat(result.local_path)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(result.local_path))).mode & 0o777, 0o700);
  assert.equal(result.checksum_matched, true);
});

test("download rejects truncated, oversized, wrong digest and version-drift streams", async () => {
  for (const failure of ["short", "long", "hash", "version"]) {
    const h = harness();
    if (failure === "short") h.client.downloadVersionStream = async () => new Response(bytes.subarray(1));
    if (failure === "long") h.client.downloadVersionStream = async () => new Response(Buffer.concat([bytes, bytes]));
    if (failure === "version") h.client.downloadVersionStream = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(bytes); c.error(new BinaryTransferError("drift", "VERSION_CHANGED")); },
    }));
    await assert.rejects(downloadLocalFile(h.client, 42, "/Private/a.zip", { ...options(), expectedSha256: failure === "hash" ? "0".repeat(64) : sha(bytes) }));
  }
});

test("abort, oversized source and invalid remote path fail before any upload", async t => {
  const { source } = await fixture(t); const h = harness();
  await assert.rejects(uploadLocalFile(h.client, 42, source, "/Private/a", { signal: AbortSignal.abort() }));
  await assert.rejects(uploadLocalFile(h.client, 42, source, "../a", options()));
  const file = await open(source, "w"); await file.truncate(LOCAL_MAX_BYTES + 1); await file.close();
  await assert.rejects(uploadLocalFile(h.client, 42, source, "/Private/a", options()), { code: "SIZE_LIMIT_EXCEEDED" });
  assert.equal(h.counts().uploads, 0);
});

test("269 MB local upload and independent readback use bounded streams, not inline payloads", async t => {
  const { source } = await fixture(t);
  const length = 269_000_000;
  const handle = await open(source, "w"); await handle.truncate(length); await handle.close();
  const h = harness(); h.file.size = length;
  const block = Buffer.alloc(64 * 1024);
  const hash = createHash("sha256");
  for (let n = 0; n < length; n += block.length) hash.update(block.subarray(0, Math.min(block.length, length - n)));
  const expectedSha256 = hash.digest("hex");
  h.client.downloadVersionStream = async () => {
    let sent = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (sent === length) { controller.close(); return; }
      const chunk = block.subarray(0, Math.min(block.length, length - sent)); sent += chunk.length; controller.enqueue(chunk);
    } }));
  };
  const result = await uploadLocalFile(h.client, 42, source, "/Private/large.bin", { ...options(), expectedSize: length, expectedSha256 });
  assert.equal(result.size_bytes, length); assert.equal(result.sha256, expectedSha256); assert.equal(result.verified, true);
});

test("verify-only checks an existing file without uploading", async () => {
  const h = harness();
  await verifyLocalTransfer(h.client, 42, "/Private/a.zip", { ...options(), expectedSize: bytes.length, expectedSha256: sha(bytes) });
  assert.equal(h.counts().uploads, 0); assert.equal(h.counts().downloads, 1);
});

test("stalled downloads abort and leave no partial temporary directory", async t => {
  const { directory } = await fixture(t);
  const before = await readdir(directory);
  const h = harness(); let cancelled = false;
  h.client.downloadVersionStream = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 100);
  try { await assert.rejects(downloadLocalFile(h.client, 42, "/Private/a", { signal: abort.signal, temporaryRoot: directory })); }
  finally { clearTimeout(timer); }
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(directory), before);
});

test("CLI rejects untrusted API configuration without echoing credentials", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/transfer-cli.ts", "download", "--path", "/Private/a"], {
    encoding: "utf8", env: { ...process.env, INFOMANIAK_API_BASE_URL: "https://attacker.invalid/secret", INFOMANIAK_ACCESS_TOKEN: "secret-token" },
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, "UNTRUSTED_API_CONFIGURATION");
  assert.ok(!result.stderr.includes("secret"));
  assert.equal(result.stdout, "");
});
