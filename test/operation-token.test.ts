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

  const [body, signature] = token.split(".");
  const tampered = `${body}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
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

test("public kDrive tool schemas expose paths but no IDs or ETags", async () => {
  const registrations = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const resourceRegistrations = new Map<string, () => Promise<Record<string, unknown>>>();
  const fakeServer = {
    registerResource(
      _name: string,
      uri: string,
      _metadata: Record<string, never>,
      read: () => Promise<Record<string, unknown>>,
    ) {
      resourceRegistrations.set(uri, read);
    },
    registerTool(
      name: string,
      definition: Record<string, unknown>,
      handler: (...args: unknown[]) => unknown,
    ) {
      registrations.set(name, definition);
      handlers.set(name, handler);
    },
  } as unknown as Pick<McpServer, "registerTool">;

  const fakeClient = {
    resolvePath: async () => ({
      id: 7,
      name: "resume.pdf",
      path: "/Private/resume.pdf",
      type: "pdf",
      mime_type: "application/pdf",
    }),
    download: async () => ({
      bytes: new Uint8Array([37, 80, 68, 70]),
      contentType: "application/pdf",
    }),
  } as unknown as KDriveClient;

  registerKDriveTools(fakeServer, fakeClient, {
    driveId: 42,
    maxReadBytes: 1_000,
    maxUploadBytes: 1_000,
    operationSecret: generateOperationSecret(),
    nonceStore: new MemoryOperationNonceStore(),
    buildOpenUrl: () => "https://example.test/open/opaque",
    connectionStatus: async () => ({
      connected: true,
      name: "kDrive",
      openUrl: "https://example.test/open/opaque",
    }),
  });

  assert.equal(registrations.size, 13);
  assert.deepEqual(
    [...resourceRegistrations.keys()].sort(),
    ["ui://kdrive/results-v2.html", "ui://kdrive/results-v3.html"],
  );
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
  assert.equal(
    ((registrations.get("kdrive_search")!._meta as Record<string, unknown>).ui as Record<string, unknown>).resourceUri,
    "ui://kdrive/results-v3.html",
  );
  assert.ok(registrations.get("kdrive_search")!.outputSchema);
  for (const [uri, readResultsResource] of resourceRegistrations) {
    const resource = await readResultsResource();
    const contents = resource.contents as Array<{ uri?: string; text?: string }>;
    assert.equal(contents[0]?.uri, uri);
    assert.match(contents[0]?.text ?? "", /notifyIntrinsicHeight/);
    assert.match(contents[0]?.text ?? "", /ui\/notifications\/size-changed/);
    assert.match(contents[0]?.text ?? "", /ResizeObserver/);
  }

  const status = await handlers.get("kdrive_connection_status")?.() as {
    content: Array<{ type: string; text?: string }>;
  };
  assert.equal(status.content.length, 1);
  assert.equal(status.content[0]?.type, "text");
  assert.match(status.content[0]?.text ?? "", /\[Open kDrive in kDrive\]\(https:\/\/example\.test\/open\/opaque\)/);
  assert.equal(status.content.some((item) => item.type === "resource_link"), false);

  const file = await handlers.get("kdrive_read_file")?.({
    path: "/Private/resume.pdf",
    mode: "base64",
  }) as { content: Array<{ type: string }> };
  assert.equal(file.content.filter((item) => item.type === "resource_link").length, 1);
});
