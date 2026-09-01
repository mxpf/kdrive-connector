import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../src/config.js";
import { KDriveApiError } from "../src/errors.js";
import { KDriveClient } from "../src/kdrive-client.js";
import { registerKDriveTools } from "../src/kdrive-tools.js";
import { generateOperationSecret, MemoryOperationNonceStore } from "../src/operation-token.js";
import { fetchUpstreamAuthToken } from "../remote/src/utils.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}>;

async function captureLogs(run: () => Promise<void>): Promise<unknown[][]> {
  const entries: unknown[][] = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args: unknown[]) => { entries.push(args); };
  console.error = (...args: unknown[]) => { entries.push(args); };
  try {
    await run();
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }
  return entries;
}

test("create-directory logs retain tracing without paths, names, IDs, messages, or stacks", async () => {
  const parentPath = "/Private/Client Alpha";
  const folderName = "Project Nebula";
  const parentId = 987654321;
  const apiError = new KDriveApiError(
    `Could not create ${parentPath}/${folderName} under folder ${parentId}`,
    503,
    "temporarily_unavailable",
  );
  apiError.stack = `KDriveApiError: sensitive failure\n    at create ${parentPath}/${folderName}:987654321`;

  const client = {
    resolvePath: async () => ({ id: parentId, name: "Client Alpha", path: parentPath, type: "dir" }),
    createDirectory: async () => { throw apiError; },
  } as unknown as KDriveClient;
  let createHandler: ToolHandler | undefined;
  const server = {
    registerResource() {},
    registerTool(name: string, _definition: Record<string, unknown>, handler: ToolHandler) {
      if (name === "kdrive_create_directory") createHandler = handler;
    },
  } as unknown as Pick<McpServer, "registerTool">;

  registerKDriveTools(server, client, {
    driveId: 42,
    maxReadBytes: 1_000,
    maxUploadBytes: 1_000,
    operationSecret: generateOperationSecret(),
    nonceStore: new MemoryOperationNonceStore(),
    buildOpenUrl: () => "https://example.test/open/opaque",
    connectionStatus: async () => ({ connected: true }),
  });

  assert.ok(createHandler);
  let result: Awaited<ReturnType<ToolHandler>> | undefined;
  const logs = await captureLogs(async () => {
    result = await createHandler!({ path: `${parentPath}/${folderName}` });
  });
  assert.equal(result?.isError, true);

  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /Private|Client Alpha|Project Nebula|987654321/);
  assert.doesNotMatch(serialized, /sensitive failure|errorStack|\"stack\"|at create/);
  assert.match(serialized, /kdrive\.create\.exception/);
  assert.match(serialized, /kdrive_api_error/);
  assert.match(serialized, /temporarily_unavailable/);
  assert.match(serialized, /503/);
});

test("API diagnostics do not log request targets, item data, access tokens, or unsafe error codes", async () => {
  const driveId = 123456789;
  const parentId = 987654321;
  const folderName = "Project Nebula";
  const accessToken = "access-token-that-must-not-be-logged";
  const config = loadConfig({
    INFOMANIAK_API_BASE_URL: "https://api.example.test",
    INFOMANIAK_DRIVE_ID: String(driveId),
  });
  let authorization = "";
  const client = new KDriveClient(config, {
    getAccessToken: async () => accessToken,
  }, async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({
      result: "success",
      data: { id: 1122334455, name: folderName, path: `/Private/${folderName}`, type: "dir" },
      error: { code: `/Private/${folderName}` },
    });
  });

  const logs = await captureLogs(async () => {
    await client.createDirectory(driveId, parentId, folderName, undefined, { traceId: "trace-safe-1" });
  });
  assert.equal(authorization, `Bearer ${accessToken}`);

  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /123456789|987654321|1122334455|Project Nebula|Private/);
  assert.doesNotMatch(serialized, /access-token-that-must-not-be-logged|authorization|Bearer/);
  assert.match(serialized, /kdrive\.api_response/);
  assert.match(serialized, /kdrive\.api_envelope/);
  assert.match(serialized, /trace-safe-1/);
  assert.doesNotMatch(serialized, /errorCode/);
});

test("failed upstream token exchange logs status but not the response body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "access_token=upstream-secret&error_description=Private%2FProject-Nebula",
    { status: 502 },
  );
  try {
    const logs = await captureLogs(async () => {
      const [token, response] = await fetchUpstreamAuthToken({
        client_id: "client-id-secret",
        client_secret: "client-secret-value",
        code: "authorization-code-secret",
        redirect_uri: "https://connector.example.test/callback",
        upstream_url: "https://github.example.test/token",
      });
      assert.equal(token, null);
      assert.equal(response?.status, 500);
    });
    const serialized = JSON.stringify(logs);
    assert.match(serialized, /exchange_upstream_token/);
    assert.match(serialized, /502/);
    assert.doesNotMatch(serialized, /upstream-secret|Project-Nebula|client-id-secret|client-secret-value|authorization-code-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
