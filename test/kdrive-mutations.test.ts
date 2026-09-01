import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KDriveClient, KDriveFile } from "../src/kdrive-client.js";
import { normalizeKDrivePath } from "../src/kdrive-client.js";
import { registerKDriveTools } from "../src/kdrive-tools.js";
import {
  assertRestorePayload,
  generateOperationSecret,
  MemoryOperationNonceStore,
  verifyKDrivePayload,
  type OperationNonceStore,
} from "../src/operation-token.js";

type ToolHandler = (input?: Record<string, unknown>) => Promise<{
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
}>;

interface MutationCall {
  sourceId: number;
  destinationId?: number;
}

function createFakeClient(source: KDriveFile, parent: KDriveFile, destination?: KDriveFile) {
  const items = new Map<number, KDriveFile>([
    [parent.id, { ...parent }],
    [source.id, { ...source }],
    ...(destination ? [[destination.id, { ...destination }] as const] : []),
  ]);
  const calls = { move: [] as MutationCall[], trash: [] as MutationCall[], restore: [] as MutationCall[] };
  let originalPath = normalizeKDrivePath(source.path ?? `/${source.name}`);

  const client = {
    resolvePath: async (_driveId: number, path: string) => {
      const normalized = normalizeKDrivePath(path);
      const item = [...items.values()].find((candidate) => !candidate.trashed
        && normalizeKDrivePath(candidate.path ?? `/${candidate.name}`) === normalized);
      if (!item) throw new Error(`No fake kDrive item exists at ${normalized}.`);
      return { ...item };
    },
    getFile: async (_driveId: number, fileId: number) => {
      const item = items.get(fileId);
      if (!item) throw new Error(`No fake kDrive item exists with ID ${fileId}.`);
      return { ...item };
    },
    move: async (_driveId: number, sourceId: number, destinationId: number) => {
      calls.move.push({ sourceId, destinationId });
      const item = items.get(sourceId)!;
      const target = items.get(destinationId)!;
      item.path = `${normalizeKDrivePath(target.path ?? `/${target.name}`)}/${item.name}`;
      item.parent_id = destinationId;
      return true;
    },
    trash: async (_driveId: number, sourceId: number) => {
      calls.trash.push({ sourceId });
      const item = items.get(sourceId)!;
      originalPath = normalizeKDrivePath(item.path ?? `/${item.name}`);
      item.trashed = true;
      return true;
    },
    restore: async (_driveId: number, sourceId: number, destinationId: number) => {
      calls.restore.push({ sourceId, destinationId });
      const item = items.get(sourceId)!;
      item.trashed = false;
      item.path = originalPath;
      item.parent_id = destinationId;
      return true;
    },
  } as unknown as KDriveClient;

  return { client, calls };
}

function registerHandlers(
  client: KDriveClient,
  nonceStore: OperationNonceStore,
  operationSecret: string,
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerResource() {},
    registerTool(
      name: string,
      _definition: Record<string, unknown>,
      handler: ToolHandler,
    ) {
      handlers.set(name, handler);
    },
  } as unknown as Pick<McpServer, "registerTool">;

  registerKDriveTools(server, client, {
    driveId: 42,
    maxReadBytes: 1_000_000,
    maxUploadBytes: 1_000_000,
    operationSecret,
    nonceStore,
    buildOpenUrl: (file) => `https://example.test/open/${file.id}`,
    connectionStatus: async () => ({ connected: true }),
  });
  return handlers;
}

function operationToken(result: Awaited<ReturnType<ToolHandler>>): string {
  const token = result.structuredContent?.operationToken;
  assert.equal(typeof token, "string");
  return token;
}

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

test("a session-local nonce store reproduces the deployed prepare/write failure", async () => {
  const sourcePath = "/Private/Source/report.pdf";
  const destinationPath = "/Private/Destination";
  const { client, calls } = createFakeClient(
    { id: 30, name: "report.pdf", path: sourcePath, parent_id: 10, type: "pdf", etag: "v1" },
    { id: 10, name: "Source", path: "/Private/Source", type: "dir" },
    { id: 20, name: "Destination", path: destinationPath, type: "dir" },
  );
  const secret = generateOperationSecret();
  const prepareHandlers = registerHandlers(client, new MemoryOperationNonceStore(), secret);
  const writeHandlers = registerHandlers(client, new MemoryOperationNonceStore(), secret);

  const prepared = await prepareHandlers.get("kdrive_prepare_change")!({
    action: "move",
    path: sourcePath,
    destinationPath,
  });
  const signedToken = operationToken(prepared);
  let moved: Awaited<ReturnType<ToolHandler>> | undefined;
  const logs = await captureLogs(async () => {
    moved = await writeHandlers.get("kdrive_move")!({
      path: sourcePath,
      destinationPath,
      operationToken: signedToken,
    });
  });

  assert.equal(moved?.isError, true);
  assert.match(moved?.content[0]?.text ?? "", /already used or expired/);
  assert.deepEqual(calls.move, []);
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /Private|Source|Destination|report\.pdf/);
  assert.doesNotMatch(serializedLogs, new RegExp(signedToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serializedLogs, /already used or expired|errorStack|\"stack\"/);
  assert.match(serializedLogs, /kdrive\.mutation\.failed/);
  assert.match(serializedLogs, /application_error/);
});

for (const source of [
  { name: "Shark Cleaning Map — Adobe XD Prototype.xd", type: "file" },
  { name: "Research & Development", type: "dir" },
]) {
  test(`move preserves shared token binding for ${source.type}s with spaces, ampersands, and Unicode`, async () => {
    const parentPath = "/Private/05 Reference/Design & Prototypes";
    const destinationPath = "/Private/02 Work/Clients/Organic/SharkNinja/Shark Cleaning Map";
    const sourcePath = `${parentPath}/${source.name}`;
    const { client, calls } = createFakeClient(
      { id: 30, name: source.name, path: sourcePath, parent_id: 10, type: source.type, etag: "v1" },
      { id: 10, name: "Design & Prototypes", path: parentPath, type: "dir" },
      { id: 20, name: "Shark Cleaning Map", path: destinationPath, type: "dir" },
    );
    const sharedStore = new MemoryOperationNonceStore();
    const secret = generateOperationSecret();
    const prepareHandlers = registerHandlers(client, sharedStore, secret);
    const writeHandlers = registerHandlers(client, sharedStore, secret);

    const prepared = await prepareHandlers.get("kdrive_prepare_change")!({
      action: "move",
      path: sourcePath,
      destinationPath,
    });
    const moved = await writeHandlers.get("kdrive_move")!({
      path: sourcePath,
      destinationPath,
      operationToken: operationToken(prepared),
    });

    assert.equal(moved.isError, undefined);
    assert.deepEqual(calls.move, [{ sourceId: 30, destinationId: 20 }]);
    assert.equal(
      moved.structuredContent?.path,
      `${destinationPath}/${source.name}`,
    );
  });
}

for (const source of [
  { name: "Résumé — final & approved.pdf", type: "pdf" },
  { name: "Archive & Référence", type: "dir" },
]) {
  test(`trash and undo preserve the original parent for ${source.type}s with special filenames`, async () => {
    const parentPath = "/Private/03 Projects/Thinkinghaus/Voice Guidelines";
    const sourcePath = `${parentPath}/${source.name}`;
    const { client, calls } = createFakeClient(
      { id: 30, name: source.name, path: sourcePath, parent_id: 10, type: source.type, etag: "v1" },
      { id: 10, name: "Voice Guidelines", path: parentPath, type: "dir" },
    );
    const sharedStore = new MemoryOperationNonceStore();
    const secret = generateOperationSecret();
    const prepareHandlers = registerHandlers(client, sharedStore, secret);
    const writeHandlers = registerHandlers(client, sharedStore, secret);

    const prepared = await prepareHandlers.get("kdrive_prepare_change")!({ action: "trash", path: sourcePath });
    const trashed = await writeHandlers.get("kdrive_trash")!({
      path: sourcePath,
      operationToken: operationToken(prepared),
    });

    assert.equal(trashed.isError, undefined);
    assert.equal(trashed.structuredContent?.recoverable, true);
    assert.deepEqual(calls.trash, [{ sourceId: 30 }]);

    const undoToken = trashed.structuredContent?.undoToken;
    assert.equal(typeof undoToken, "string");
    const undoPayload = await verifyKDrivePayload(secret, undoToken as string);
    assertRestorePayload(undoPayload, 42);
    assert.equal(undoPayload.destinationDirectoryId, 10);

    const restored = await writeHandlers.get("kdrive_restore_from_trash")!({ undoToken });
    assert.equal(restored.isError, undefined);
    assert.deepEqual(calls.restore, [{ sourceId: 30, destinationId: 10 }]);
    assert.equal(restored.structuredContent?.path, sourcePath);
  });
}

test("canonical Unicode normalization cannot change a signed move target", async () => {
  const composedPath = "/Private/Résumé — final.pdf";
  const decomposedPath = "/Private/Résumé — final.pdf";
  const destinationPath = "/Private/Archive & Records";
  const { client, calls } = createFakeClient(
    { id: 30, name: "Résumé — final.pdf", path: composedPath, parent_id: 10, type: "pdf", etag: "v1" },
    { id: 10, name: "Private", path: "/Private", type: "dir" },
    { id: 20, name: "Archive & Records", path: destinationPath, type: "dir" },
  );
  const sharedStore = new MemoryOperationNonceStore();
  const secret = generateOperationSecret();
  const prepareHandlers = registerHandlers(client, sharedStore, secret);
  const writeHandlers = registerHandlers(client, sharedStore, secret);

  const prepared = await prepareHandlers.get("kdrive_prepare_change")!({
    action: "move",
    path: decomposedPath,
    destinationPath,
  });
  assert.equal(prepared.structuredContent?.sourcePath, composedPath);
  const moved = await writeHandlers.get("kdrive_move")!({
    path: decomposedPath,
    destinationPath,
    operationToken: operationToken(prepared),
  });

  assert.equal(moved.isError, undefined);
  assert.deepEqual(calls.move, [{ sourceId: 30, destinationId: 20 }]);
});
