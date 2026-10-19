import assert from "node:assert/strict";
import test from "node:test";
import { quotaErrorDetails } from "../src/quota-errors.js";

test("quota errors identify UTC reset without confusing authentication or leaking raw details", () => {
  const result = quotaErrorDetails(new Error("SQL query failed: Exceeded allowed rows written in Durable Objects free tier. sensitive-data"), "test-trace", Date.parse("2026-10-19T21:15:00Z"));
  assert.equal(result?.retry_at, "2026-10-20T00:00:00.000Z");
  assert.equal(result?.retry_after_seconds, 9900);
  assert.equal(result?.requires_reauthentication, false);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-data/);
  for (const message of ["Unauthorized", "HTTP 401", "HTTP 403", "SQL query failed: unknown column"]) {
    assert.equal(quotaErrorDetails(new Error(message)), undefined);
  }
});

test("status, browsing and binary tools preserve actionable quota details", async () => {
  const { registerKDriveTools } = await import("../src/kdrive-tools.js");
  const { MemoryOperationNonceStore } = await import("../src/operation-token.js");
  const handlers = new Map<string, (input: any) => Promise<any>>();
  const server = { registerResource() {}, registerTool(name: string, _schema: unknown, handler: any) { handlers.set(name, handler); } };
  const fail = async () => { throw new Error("SQL query failed: Exceeded allowed rows written in Durable Objects free tier. sensitive-data"); };
  registerKDriveTools(server as any, { resolvePath: fail, resolveBinaryVersion: fail } as any, {
    driveId: 42, maxReadBytes: 1000, maxUploadBytes: 1000,
    operationSecret: "test-only-secret", nonceStore: new MemoryOperationNonceStore(),
    buildOpenUrl: () => "https://example.test/open", connectionStatus: fail,
    buildBinaryExport: async () => { throw new Error("must fail before export"); },
  });
  for (const [name, input] of [
    ["kdrive_connection_status", {}],
    ["kdrive_list_directory", { directoryPath: "/Private", limit: 100 }],
    ["kdrive_export_file", { path: "/synthetic.pdf" }],
  ] as const) {
    const result = await handlers.get(name)!(input);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error_code, "CLOUDFLARE_QUOTA_EXCEEDED");
    assert.equal(result.structuredContent.requires_reauthentication, false);
    assert.ok(result.structuredContent.trace_id);
    assert.ok(result.structuredContent.retry_at);
    assert.doesNotMatch(JSON.stringify(result), /sensitive-data/);
  }
});
