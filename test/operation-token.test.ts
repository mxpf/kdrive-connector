import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KDriveClient } from "../src/kdrive-client.js";
import { registerKDriveTools } from "../src/kdrive-tools.js";
import {
  assertOperationPayload,
  createOperationPayload,
  generateOperationSecret,
  MemoryOperationNonceStore,
  sha256Base64Url,
  signKDrivePayload,
  verifyKDrivePayload,
} from "../src/operation-token.js";

test("signed operation tokens verify and reject tampering or expiry", async () => {
  const now = Date.now();
  const secret = generateOperationSecret();
  const payload = createOperationPayload({
    action: "move",
    driveId: 42,
    sourceId: 7,
    sourcePath: "/Private/report.pdf",
    sourceEtag: "version-a",
    destinationId: 9,
    destinationPath: "/Private/Archive",
  }, 60_000, now);
  const token = await signKDrivePayload(secret, payload);
  const verified = await verifyKDrivePayload(secret, token, now + 1);
  assertOperationPayload(verified, "move", 42);
  assert.equal(verified.sourcePath, "/Private/report.pdf");

  const last = token.at(-1);
  const tampered = `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  await assert.rejects(() => verifyKDrivePayload(secret, tampered, now + 1), /Invalid signed kDrive token/);
  await assert.rejects(() => verifyKDrivePayload(secret, token, now + 60_001), /expired/);
  await assert.rejects(() => verifyKDrivePayload(generateOperationSecret(), token, now + 1), /Invalid signed kDrive token/);
});

test("operation nonces can be consumed only once", () => {
  const store = new MemoryOperationNonceStore();
  const now = Date.now();
  store.issue("one-use", now + 10_000);
  assert.equal(store.consume("one-use", now), true);
  assert.equal(store.consume("one-use", now), false);

  store.issue("expired", now - 1);
  assert.equal(store.consume("expired", now), false);
});

test("overwrite content digests bind exact bytes and encoding", async () => {
  const utf8 = new TextEncoder().encode("kDrive contents");
  const changed = new TextEncoder().encode("kDrive contents!");
  assert.notEqual(await sha256Base64Url(utf8), await sha256Base64Url(changed));
  assert.equal(await sha256Base64Url(utf8), await sha256Base64Url(new Uint8Array(utf8)));
});

test("public kDrive tool schemas expose paths but no IDs or ETags", () => {
  const registrations = new Map<string, Record<string, unknown>>();
  const fakeServer = {
    registerTool(name: string, definition: Record<string, unknown>) {
      registrations.set(name, definition);
    },
  } as unknown as Pick<McpServer, "registerTool">;

  registerKDriveTools(fakeServer, {} as KDriveClient, {
    driveId: 42,
    maxReadBytes: 1_000,
    maxUploadBytes: 1_000,
    operationSecret: generateOperationSecret(),
    nonceStore: new MemoryOperationNonceStore(),
    buildOpenUrl: () => "https://example.test/open/opaque",
    connectionStatus: async () => ({ connected: true }),
  });

  assert.equal(registrations.size, 13);
  const forbidden = new Set(["fileId", "directoryId", "parentId", "destinationDirectoryId", "restoreId", "etag"]);
  for (const [name, definition] of registrations) {
    const schema = definition.inputSchema as Record<string, unknown>;
    for (const key of Object.keys(schema)) {
      assert.equal(forbidden.has(key), false, `${name} exposes internal parameter ${key}`);
    }
  }
  assert.deepEqual(
    Object.keys(registrations.get("kdrive_move")!.inputSchema as Record<string, unknown>).sort(),
    ["destinationPath", "operationToken", "path"],
  );
});
