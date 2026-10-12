import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { BinaryTransferError, hashBinary } from "../src/binary-transport.js";
import { uploadWithReceipt, verifyReceipt, readManifest, previewBatch, executeBatch } from "../src/transfer-workflows.js";
import { readReceipt, newReceipt, saveReceipt } from "../src/transfer-journal.js";
import { transferDoctor } from "../src/transfer-doctor.js";
import { progressReporter } from "../src/transfer-progress.js";
import { loadConfig } from "../src/config.js";
import type { TransferClient } from "../src/local-transfer.js";

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kdrive-workflow-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("archive fixture");
  const source = path.join(dir, "source.zip"); await writeFile(source, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = { id: 42, name: "one.zip", type: "file", size: bytes.length, etag: "v1" };
  let uploads = 0;
  const client: TransferClient = {
    resolvePath: async () => ({ id: 7, name: "folder", type: "dir" }),
    resolveBinaryVersion: async () => ({ file, versionId: "v1" }),
    downloadVersionStream: async () => new Response(bytes),
    uploadBinary: async (_drive, input) => { uploads++; file.name = input.fileName; return { file, ...await hashBinary(input.body, input.size, input.signal) }; },
  };
  return { dir, bytes, source, sha256, client, uploads: () => uploads,
    item: { source, path: "/Private/one.zip", size: bytes.length, sha256 },
    options: { signal: AbortSignal.timeout(5000), temporaryRoot: dir }, journal: path.join(dir, "receipts") };
}

test("upload persists a private receipt before mutation and after verification", async t => {
  const f = await fixture(t); const upload = f.client.uploadBinary;
  f.client.uploadBinary = async (...args) => {
    const files = await readdir(f.journal);
    const receipt = await readReceipt(path.join(f.journal, files[0]));
    assert.equal(receipt.state, "uploading"); assert.equal(receipt.sha256, f.sha256);
    return upload(...args);
  };
  const result = await uploadWithReceipt(f.client, 1, f.source, f.item.path, f.options, f.journal);
  assert.equal((await readReceipt(result.receipt_path)).state, "verified");
  assert.equal((await stat(result.receipt_path)).mode & 0o777, 0o600);
  assert.equal((await stat(f.journal)).mode & 0o777, 0o700);
  assert.equal(f.uploads(), 1);
});

test("committed failed readback survives as a receipt and verify never uploads again", async t => {
  const f = await fixture(t); const download = f.client.downloadVersionStream;
  f.client.downloadVersionStream = async () => { throw new Error("SECRET_URL"); };
  let filename = "";
  await assert.rejects(uploadWithReceipt(f.client, 1, f.source, f.item.path, f.options, f.journal), (error: any) => {
    assert.equal(error.code, "UPLOADED_NOT_VERIFIED"); filename = error.receipt.receipt_path;
    assert.ok(!JSON.stringify(error).includes("SECRET")); return true;
  });
  const receipt = await readReceipt(filename); assert.equal(receipt.state, "unverified"); assert.equal(receipt.file_id, 42);
  f.client.downloadVersionStream = download;
  await verifyReceipt(f.client, 1, filename, f.options);
  assert.equal(f.uploads(), 1); assert.equal((await readReceipt(filename)).state, "verified");
  await assert.rejects(verifyReceipt(f.client, 2, filename, f.options), { code: "RECEIPT_DRIVE_MISMATCH" });
  f.client.resolveBinaryVersion = async () => ({ file: { id: 43, name: "one.zip", type: "file", size: f.bytes.length }, versionId: "v1" });
  await assert.rejects(verifyReceipt(f.client, 1, filename, f.options), { code: "DESTINATION_CHANGED" });
});

test("unknown commit and interrupted uploading receipt require verification, never replay", async t => {
  const f = await fixture(t);
  f.client.uploadBinary = async () => { throw new BinaryTransferError("ambiguous", "UPLOAD_COMMIT_UNKNOWN"); };
  await assert.rejects(uploadWithReceipt(f.client, 1, f.source, f.item.path, f.options, f.journal), { code: "UPLOAD_COMMIT_UNKNOWN" });
  const name = path.join(f.journal, (await readdir(f.journal))[0]);
  assert.equal((await readReceipt(name)).state, "unknown");
  await verifyReceipt(f.client, 1, name, f.options);
  const interrupted = await newReceipt(1, f.item.path, f.journal);
  await saveReceipt(interrupted.filename, { ...interrupted.receipt, state: "uploading", sha256: f.sha256, size_bytes: f.bytes.length });
  await verifyReceipt(f.client, 1, interrupted.filename, f.options);
  assert.equal((await readReceipt(interrupted.filename)).state, "verified");
});

test("manifest validates every source before any upload and preview has no provider calls", async t => {
  const f = await fixture(t); const manifest = path.join(f.dir, "manifest.json");
  await writeFile(manifest, JSON.stringify({ version: 1, files: [f.item] }));
  const items = await readManifest(manifest);
  assert.equal((await previewBatch(items, f.options)).files[0].source_verified, true);
  assert.equal(f.uploads(), 0);
  const bad = { ...f.item, path: "/Private/two.zip", sha256: "0".repeat(64) };
  await assert.rejects(executeBatch(f.client, 1, [f.item, bad], f.options, f.journal), { code: "INTEGRITY_MISMATCH" });
  assert.equal(f.uploads(), 0);
  assert.equal((await executeBatch(f.client, 1, items, f.options, f.journal)).verified, true);
  await writeFile(manifest, JSON.stringify({ version: 1, files: [f.item, f.item] }));
  await assert.rejects(readManifest(manifest), { code: "DUPLICATE_MANIFEST_DESTINATION" });
});

test("batch stops after a conflict, reports unstarted files, and never overwrites", async t => {
  const f = await fixture(t); let calls = 0;
  f.client.uploadBinary = async () => { calls++; throw new BinaryTransferError("conflict", "DESTINATION_CONFLICT"); };
  const result = await executeBatch(f.client, 1, [f.item, { ...f.item, path: "/Private/two.zip" }], f.options, f.journal);
  assert.equal(result.verified, false); assert.equal(calls, 1);
  assert.equal(result.files[0].error, "DESTINATION_CONFLICT"); assert.equal(result.files[1].status, "not_started");
});

test("doctor works offline without reading token contents or exposing credentials", async t => {
  const f = await fixture(t); const token = path.join(f.dir, "tokens.json");
  await writeFile(token, "SECRET_INVALID_TOKEN_JSON");
  const config = loadConfig({ INFOMANIAK_DRIVE_ID: "42", KDRIVE_TOKEN_FILE: token });
  const result = await transferDoctor(config, { nodeVersion: "24.0.0", temporaryRoot: f.dir, buildFile: f.source, hasKeychainToken: () => { throw new Error("not needed"); } });
  assert.equal(result.ready, true); assert.equal(result.checks.credentials, "token_file");
  assert.equal(result.connection, "not_checked"); assert.ok(!JSON.stringify(result).includes("SECRET"));
  const missing = await transferDoctor(loadConfig({ KDRIVE_TOKEN_FILE: path.join(f.dir, "missing") }),
    { nodeVersion: "20.0.0", buildFile: "missing", temporaryRoot: "missing", hasKeychainToken: () => false });
  assert.equal(missing.ready, false); assert.ok(missing.next_steps.length >= 4);
  const online = await transferDoctor(config, { buildFile: f.source, temporaryRoot: f.dir, onlineCheck: async () => { throw new Error("SECRET"); } });
  assert.equal(online.connection, "failed"); assert.ok(!JSON.stringify(online).includes("SECRET"));
});

test("progress is throttled, includes stage completion, and rejects arbitrary labels", () => {
  let time = 0; const output: string[] = [];
  const report = progressReporter(text => output.push(text), () => time);
  report({ stage: "uploading", bytes: 0, total: 100 });
  for (let n = 1; n < 100; n++) report({ stage: "uploading", bytes: n, total: 100 });
  assert.equal(output.length, 1);
  report({ stage: "uploading", bytes: 100, total: 100 });
  time = 1200; report({ stage: "SECRET", bytes: 0, total: 100 });
  assert.equal(output.length, 3); assert.ok(!output.join("").includes("SECRET"));
  report({ stage: "preparing", bytes: 100, total: 100 });
  report({ stage: "preparing", bytes: 0, total: 100 });
  report({ stage: "preparing", bytes: 100, total: 100 });
  assert.equal(output.length, 6);
});

test("unsafe journal permissions stop uploads before provider mutation", async t => {
  const f = await fixture(t);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(f.journal, { mode: 0o755 });
  await assert.rejects(uploadWithReceipt(f.client, 1, f.source, f.item.path, f.options, f.journal), { code: "PRIVATE_RECEIPT_DIRECTORY_REQUIRED" });
  assert.equal(f.uploads(), 0);
});

test("receipt parsing rejects malformed data and strips unknown fields", async t => {
  const f = await fixture(t); const journal = await newReceipt(1, f.item.path, f.journal);
  await writeFile(journal.filename, JSON.stringify({ ...journal.receipt, secret: "SECRET", error: "https://SECRET" }));
  assert.ok(!JSON.stringify(await readReceipt(journal.filename)).includes("SECRET"));
  await writeFile(journal.filename, JSON.stringify({ ...journal.receipt, sha256: "bad" }));
  await assert.rejects(readReceipt(journal.filename), { code: "INVALID_RECEIPT" });
});
