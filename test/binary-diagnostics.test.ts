import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { connectorDiagnostics } from "../src/connector-diagnostics.js";
import { uploadedBinaryResult, registerBinaryTools } from "../src/binary-tools.js";
import { createBinaryExport, serveBinaryExport } from "../src/binary-export.js";
import { generateOperationSecret } from "../src/operation-token.js";
import { BinaryTransferError, validateSourceUrl } from "../src/binary-transport.js";
import { binaryErrorCode } from "../src/binary-diagnostics.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KDriveClient } from "../src/kdrive-client.js";

test("diagnostics distinguish builds, capabilities and effective limits", () => {
  const remote = connectorDiagnostics({ buildId: "worker-version", binaryExport: true, maxReadBytes: 1, maxUploadBytes: 2, maxBinaryBytes: 3 });
  assert.equal(remote.build_id, "worker-version");
  assert.equal(remote.capabilities.binary_export, true);
  assert.equal(remote.limits.binary_bytes, 3);
  assert.equal(remote.capabilities.range_download, false);
  assert.ok(remote.capability_revision);
  const local = connectorDiagnostics({ binaryExport: false, maxReadBytes: 1, maxUploadBytes: 2 });
  assert.equal(local.build_id, "unknown-local-build");
  assert.equal(local.capabilities.binary_export, false);
  assert.equal(local.limits.binary_bytes, 104857600);
});

test("committed upload remains successful when optional link generation fails", async () => {
  const result = { file: { id: 1, name: "test.png", type: "file", mime_type: "image/png", etag: "v1" }, size_bytes: 5, sha256: "a".repeat(64) };
  const value = await uploadedBinaryResult(result, "/Private/test.png", async () => { throw new Error("private signing secret"); });
  assert.equal(value.status, "uploaded");
  assert.equal(value.warning_code, "OPEN_URL_UNAVAILABLE");
  assert.equal(value.path, "/Private/test.png");
  assert.equal(value.sha256, result.sha256);
  assert.equal(value.resolved_version, "v1");
  assert.equal(value.openUrl, undefined);
  assert.doesNotMatch(JSON.stringify(value), /private signing secret/);
  assert.equal((await uploadedBinaryResult(result, "/Private/test.png", () => "https://example.com/open")).openUrl, "https://example.com/open");
});

test("binary errors have stable codes without reflecting untrusted upstream text", () => {
  assert.throws(() => validateSourceUrl("https://example.com/private?secret=hidden", []), (error) => {
    assert.equal(binaryErrorCode(error), "SOURCE_HOST_DENIED");
    assert.doesNotMatch(String(error), /hidden/);
    return true;
  });
  assert.equal(binaryErrorCode(new DOMException("private", "TimeoutError")), "TRANSFER_TIMEOUT");
  assert.equal(binaryErrorCode(new Error("private")), "UPSTREAM_UNAVAILABLE");
});

test("export call and download traces correlate without logging file data or signed references", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "info", (value: string) => logs.push(value));
  t.mock.method(console, "error", (value: string) => logs.push(value));
  const handlers = new Map<string, (input: any) => Promise<any>>();
  const server = { registerTool(name: string, _config: unknown, handler: any) { handlers.set(name, handler); } } as unknown as Pick<McpServer, "registerTool">;
  const bytes = new TextEncoder().encode("private-file-content");
  const secret = generateOperationSecret();
  const provider = {
    resolveBinaryVersion: async () => ({ file: { id: 1, name: "private-name.png", type: "file", size: bytes.length }, versionId: "v1" }),
    downloadVersionStream: async () => new Response(bytes),
  } as unknown as KDriveClient;
  registerBinaryTools(server, provider, { driveId: 42, buildOpenUrl: () => "unused",
    buildBinaryExport: (file, version, digest) => createBinaryExport(secret, "https://connector.example.com", "owner", 42, file, version, digest) });
  const result = await handlers.get("kdrive_export_file")!({ path: "/Private/private-name.png" });
  const ref = result.structuredContent;
  const response = await serveBinaryExport(new Request(ref.download_url), ref.download_url.split("/binary/")[1], { secret, subject: "owner", driveId: 42, client: provider });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  const events = logs.map(line => JSON.parse(line));
  assert.ok(events.some(e => e.operation === "kdrive_export_file" && e.traceId === ref.trace_id && e.ok));
  assert.ok(events.some(e => e.operation === "binary_download" && e.parentTraceId === ref.trace_id && e.bytes === bytes.length && e.event.endsWith("completed")));
  assert.ok(response.headers.get("x-kdrive-trace-id"));
  assert.doesNotMatch(logs.join(""), /private-file-content|private-name|https:|download_url/);
  assert.ok(!logs.join("").includes(secret));
  provider.resolveBinaryVersion = async () => { throw new Error("https://private.example.com/?credential=secret"); };
  const failed = await handlers.get("kdrive_export_file")!({ path: "/Private/private-name.png" });
  assert.equal(failed.isError, true);
  const error = JSON.parse(failed.content[0].text);
  assert.equal(error.error_code, "UPSTREAM_UNAVAILABLE");
  assert.equal(error.stage, "resolve");
  assert.ok(error.trace_id);
  assert.doesNotMatch(JSON.stringify(failed) + logs.join(""), /credential=secret|private\.example/);
});

test("download deadline is 504 while invalid references remain 410", async () => {
  const secret = generateOperationSecret();
  const ref = await createBinaryExport(secret, "https://connector.example.com", "owner", 42,
    { id: 1, name: "test", type: "file" }, "v1", { size_bytes: 0, sha256: createHash("sha256").digest("hex") });
  const config = { secret, subject: "owner", driveId: 42, client: { downloadVersionStream: async (): Promise<Response> => { throw new BinaryTransferError("deadline", "TRANSFER_TIMEOUT"); } } };
  const response = await serveBinaryExport(new Request(ref.download_url), ref.download_url.split("/binary/")[1], config);
  assert.equal(response.status, 504);
  assert.equal(response.headers.get("x-kdrive-error-code"), "TRANSFER_TIMEOUT");
  assert.equal((await serveBinaryExport(new Request(ref.download_url), "invalid", config)).status, 410);
});
