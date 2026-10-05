import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { KDriveClient } from "../src/kdrive-client.js";
import { loadConfig } from "../src/config.js";
import { createBinaryExport, serveBinaryExport } from "../src/binary-export.js";
import { generateOperationSecret } from "../src/operation-token.js";
import { materializeBinaryReference } from "../src/binary-materialize.js";
import { BinaryDownloadError } from "../src/download-diagnostics.js";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fetchBinarySource, classifyBinaryFailure } from "../src/binary-transport.js";
import { KDriveApiError } from "../src/errors.js";

const failureCases = [
  [401, "UPSTREAM_AUTHENTICATION_FAILED"], [403, "UPSTREAM_ACCESS_DENIED"],
  [429, "UPSTREAM_RATE_LIMITED"], [503, "UPSTREAM_UNAVAILABLE"],
  [0, "TRANSFER_TIMEOUT"],
] as const;

for (const [status, code] of failureCases) test(`source boundary preserves ${code}`, async () => {
  await assert.rejects(() => fetchBinarySource("https://trusted.example/private?token=SECRET", ["trusted.example"], new AbortController().signal,
    async () => {
      if (!status) throw new DOMException("SECRET", "TimeoutError");
      return new Response("SECRET", { status });
    }, async () => {}), (error: unknown) => {
    assert.equal(classifyBinaryFailure(error), code);
    assert.doesNotMatch(String(error), /SECRET|https:/); return true;
  });
});

for (const stage of ["start", "chunk", "finish"]) for (const [status, code] of failureCases) test(`upload ${stage} boundary preserves ${code} or commit uncertainty`, async () => {
  const client = new KDriveClient(loadConfig({ INFOMANIAK_DRIVE_ID: "42" }), { getAccessToken: async () => "token" }, async (url, init) => {
    if (init?.method === "DELETE") return Response.json({ result: "success", data: true });
    const path = new URL(String(url)).pathname;
    if (path.endsWith(`/${stage}`)) {
      if (!status) throw new DOMException("SECRET", "TimeoutError");
      throw new KDriveApiError("SECRET", status);
    }
    return Response.json({ result: "success", data: path.endsWith("/start") ? { token: "test", upload_url: "https://api.infomaniak.com/" } : { status: "ok" } });
  });
  await assert.rejects(() => client.uploadBinary(42, { body: new Response(new Uint8Array([1])).body!, size: 1, fileName: "test", directoryId: 1, signal: new AbortController().signal }), (error: unknown) => {
    assert.equal(classifyBinaryFailure(error), stage === "finish" ? "UPLOAD_COMMIT_UNKNOWN" : code);
    assert.doesNotMatch(String(error), /SECRET/); return true;
  });
});

test("real stdio MCP exchange keeps successful diagnostics off the protocol channel", async () => {
  const script = `
    import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { binaryTrace } from './src/binary-diagnostics.ts';
    import { logOperationalInfo } from './src/operational-logging.ts';
    const server = new McpServer({name:'test',version:'1'});
    server.registerTool('test_trace', {inputSchema:{}}, async () => {
      logOperationalInfo({event:'ordinary.test'});
      const trace = binaryTrace('test_trace');
      trace.progress('download', 5); trace.complete(true);
      return {content:[{type:'text',text:'ok'}]};
    });
    await server.connect(new StdioServerTransport());
  `;
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "--input-type=module", "-e", script], stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  const client = new Client({ name: "test", version: "1" });
  const errors: Error[] = [];
  client.onerror = error => errors.push(error);
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools[0].name, "test_trace");
    const result = await client.callTool({ name: "test_trace", arguments: {} });
    assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
  } finally { await client.close(); }
  assert.deepEqual(errors, []);
  assert.match(stderr, /ordinary.test/);
  assert.match(stderr, /kdrive.binary.completed/);
});

const origin = "https://connector.example.com";
for (const [upstream, status, code] of [
  [404, 409, "VERSION_CHANGED"], [410, 409, "VERSION_CHANGED"],
  [401, 502, "UPSTREAM_AUTHENTICATION_FAILED"], [403, 502, "UPSTREAM_ACCESS_DENIED"],
  [429, 429, "UPSTREAM_RATE_LIMITED"], [503, 502, "UPSTREAM_UNAVAILABLE"],
] as const) test(`pinned metadata HTTP ${upstream} becomes ${code}`, async () => {
  const secret = generateOperationSecret();
  const ref = await createBinaryExport(secret, origin, "owner", 42, { id: 1, name: "file", type: "file" }, "v1", { size_bytes: 1, sha256: "a".repeat(64) });
  const client = new KDriveClient(loadConfig({ INFOMANIAK_DRIVE_ID: "42" }), { getAccessToken: async () => "secret" }, async () => Response.json({ result: "error", error: { description: "PRIVATE_CREDENTIAL" } }, { status: upstream }));
  const response = await serveBinaryExport(new Request(ref.download_url), new URL(ref.download_url).pathname.slice(8), { secret, subject: "owner", driveId: 42, client });
  assert.equal(response.status, status);
  assert.equal(response.headers.get("x-kdrive-error-code"), code);
  assert.doesNotMatch(await response.text(), /PRIVATE_CREDENTIAL/);
});

test("local bridge preserves only safe diagnostics and cleans failed downloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kdrive-diagnostics-test-"));
  const trace = "ed8b7a22-1234-4567-8901-123456789abc";
  try {
    const ref = await createBinaryExport(generateOperationSecret(), origin, "owner", 42, { id: 1, name: "file", type: "file" }, "v1", { size_bytes: 1, sha256: "a".repeat(64) });
    for (const [status, code] of [[409, "VERSION_CHANGED"], [410, "REFERENCE_INVALID_OR_EXPIRED"], [429, "UPSTREAM_RATE_LIMITED"], [502, "UPSTREAM_AUTHENTICATION_FAILED"], [504, "TRANSFER_TIMEOUT"]] as const) {
      await assert.rejects(() => materializeBinaryReference(ref, { origin, directory, fetcher: async () => new Response("PRIVATE_BODY", { status, headers: { "x-kdrive-error-code": code, "x-kdrive-trace-id": trace } }) }), (error: unknown) => {
        assert.ok(error instanceof BinaryDownloadError);
        assert.equal(error.code, code); assert.equal(error.traceId, trace);
        assert.doesNotMatch(error.message, /PRIVATE_BODY|https:/); return true;
      });
      assert.deepEqual(await readdir(directory), []);
    }
    await assert.rejects(() => materializeBinaryReference(ref, { origin, directory, fetcher: async () => new Response("SECRET", { status: 502, headers: { "x-kdrive-error-code": "SECRET", "x-kdrive-trace-id": "https://secret.example/token" } }) }), (error: unknown) => {
      assert.ok(error instanceof BinaryDownloadError);
      assert.equal(error.code, "UPSTREAM_UNAVAILABLE"); assert.equal(error.traceId, undefined);
      assert.doesNotMatch(error.message, /SECRET|secret.example/); return true;
    });
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("download CLI reports safe diagnostics on stderr without echoing credentials", async () => {
  const ref = await createBinaryExport(generateOperationSecret(), origin, "owner", 42,
    { id: 1, name: "file", type: "file" }, "v1", { size_bytes: 1, sha256: "a".repeat(64) });
  const trace = "ed8b7a22-1234-4567-8901-123456789abc";
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    globalThis.fetch = async () => new Response('PRIVATE_BODY', {status:502, headers:{
      'x-kdrive-error-code':'UPSTREAM_AUTHENTICATION_FAILED', 'x-kdrive-trace-id':'${trace}'
    }});
    await import('./src/download-cli.ts');
  `], { encoding: "utf8", input: JSON.stringify(ref), env: { ...process.env, KDRIVE_CONNECTOR_BASE_URL: origin }, timeout: 10000 });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /UPSTREAM_AUTHENTICATION_FAILED/);
  assert.ok(child.stderr.includes(trace));
  assert.doesNotMatch(child.stderr, /PRIVATE_BODY|https:|\/binary\//);
});
