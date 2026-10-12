import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/transfer-cli.ts", ...args], {
  encoding: "utf8", timeout: 5000,
  env: { ...process.env, INFOMANIAK_API_BASE_URL: "https://invalid.example/SECRET", INFOMANIAK_ACCESS_TOKEN: "SECRET" },
});

test("CLI batch defaults to offline preview with clean JSON; progress is explicit", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kdrive-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source"); await writeFile(source, "fixture");
  const manifest = path.join(directory, "manifest.json");
  await writeFile(manifest, JSON.stringify({ version: 1, files: [{ source, path: "/Private/fixture", size: 7,
    sha256: createHash("sha256").update("fixture").digest("hex") }] }));
  const preview = run(["batch", "--manifest", manifest]);
  assert.equal(preview.status, 0); assert.equal(preview.stderr, "");
  assert.equal(JSON.parse(preview.stdout).preview, true);
  const progress = run(["batch", "--manifest", manifest, "--progress"]);
  assert.equal(progress.status, 0); assert.match(progress.stderr, /preparing: 7\/7 bytes/);
  assert.equal(JSON.parse(progress.stdout).files.length, 1);
  const quiet = run(["batch", "--manifest", manifest, "--progress", "--quiet"]);
  assert.equal(quiet.stderr, "");
  const execute = run(["batch", "--manifest", manifest, "--execute"]);
  assert.equal(execute.status, 1); assert.equal(JSON.parse(execute.stderr).error, "UNTRUSTED_API_CONFIGURATION");
  assert.ok(!execute.stderr.includes("SECRET"));
});

test("CLI rejects irrelevant flags and incomplete verification before authentication", () => {
  for (const args of [["toString"], ["__proto__"], ["upload", "--path", "/Private/a", "--source", "/tmp/a", "--execute"],
    ["verify", "--path", "/Private/a"], ["verify", "--receipt", "/tmp/a", "--path", "/Private/a"], ["doctor", "--manifest", "/tmp/a"]]) {
    const result = run(args); assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, "INVALID_ARGUMENTS"); assert.equal(result.stdout, "");
  }
});

test("CLI doctor reports untrusted configuration offline without reading secrets", () => {
  const result = run(["doctor"]);
  assert.equal(result.status, 1); assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.connection, "not_checked"); assert.equal(report.checks.trusted_origins, false);
  assert.ok(!result.stdout.includes("SECRET"));
});
