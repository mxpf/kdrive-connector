import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KDriveClient, splitKDrivePath, type KDriveFile } from "./kdrive-client.js";
import { validateName } from "./safety.js";

export interface KDriveToolConfig {
  driveId: number;
  maxReadBytes: number;
  maxUploadBytes: number;
  connectionStatus: () => Promise<unknown>;
}

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorContent(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function tool<T>(handler: () => Promise<T>) {
  return handler().then(jsonContent).catch(errorContent);
}

function cleanItem(file: KDriveFile) {
  return {
    name: file.name,
    path: file.path,
    type: file.type,
    status: file.status,
    size: file.size,
    mimeType: file.mime_type,
    lastModifiedAt: file.last_modified_at,
  };
}

async function resolveItem(
  client: KDriveClient,
  driveId: number,
  input: { fileId?: number; path?: string },
  options: { defaultToRoot?: boolean; requireDirectory?: boolean } = {},
): Promise<KDriveFile> {
  if (input.fileId && input.path) throw new Error("Provide a path or an ID, not both.");
  let file: KDriveFile;
  if (input.path) file = await client.resolvePath(driveId, input.path);
  else if (input.fileId) file = await client.getFile(driveId, input.fileId);
  else if (options.defaultToRoot) file = await client.getFile(driveId, 1);
  else throw new Error("Provide the item's kDrive path.");
  if (options.requireDirectory && file.type !== "dir") {
    throw new Error(`${file.path ?? file.name} is not a folder.`);
  }
  return file;
}

async function resolveDestination(
  client: KDriveClient,
  driveId: number,
  input: { directoryId?: number; directoryPath?: string },
): Promise<KDriveFile> {
  return resolveItem(client, driveId, {
    fileId: input.directoryId,
    path: input.directoryPath,
  }, { defaultToRoot: true, requireDirectory: true });
}

async function resultAfterMutation(client: KDriveClient, driveId: number, fileId: number) {
  return cleanItem(await client.getFile(driveId, fileId));
}

const positiveId = z.number().int().positive();
const path = z.string().min(1).max(4096);
const fileType = z.enum([
  "archive", "audio", "code", "diagram", "dir", "email", "font", "form", "image", "model",
  "pdf", "presentation", "spreadsheet", "text", "unknown", "video",
]);

export function registerKDriveTools(server: Pick<McpServer, "registerTool">, client: KDriveClient, config: KDriveToolConfig): void {
  server.registerTool(
    "kdrive_connection_status",
    {
      title: "Check kDrive connection",
      description: "Verify the connection to the selected Infomaniak kDrive.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => tool(config.connectionStatus),
  );

  server.registerTool(
    "kdrive_get_file",
    {
      title: "Get kDrive item details",
      description: "Get concise details for a file or folder. Prefer its natural kDrive path, such as /Private/Invoices/report.pdf.",
      inputSchema: { path: path.optional(), fileId: positiveId.optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => tool(async () => cleanItem(await resolveItem(client, config.driveId, input, { defaultToRoot: true }))),
  );

  server.registerTool(
    "kdrive_list_directory",
    {
      title: "List a kDrive folder",
      description: "List files and folders at a kDrive path. Omit the path for the root; pass cursor only when continuing a prior result.",
      inputSchema: {
        directoryPath: path.optional(),
        directoryId: positiveId.optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(5).max(1000).default(100),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ directoryPath, directoryId, cursor, limit }) => tool(async () => {
      const directory = await resolveDestination(client, config.driveId, { directoryPath, directoryId });
      const page = await client.listDirectory(config.driveId, directory.id, { cursor, limit });
      return { folder: directory.path ?? directory.name, items: page.data.map(cleanItem), cursor: page.cursor, hasMore: page.has_more ?? false };
    }),
  );

  server.registerTool(
    "kdrive_search",
    {
      title: "Search kDrive",
      description: "Search recursively by filename and, when supported, document content. Use directoryPath to narrow the search naturally.",
      inputSchema: {
        query: z.string().min(3).max(500),
        directoryPath: path.optional(),
        directoryId: positiveId.optional(),
        queryScope: z.enum(["all", "content", "filename"]).default("all"),
        types: z.array(fileType).max(20).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(5).max(1000).default(50),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, directoryPath, directoryId, queryScope, types, cursor, limit }) => tool(async () => {
      let resolvedDirectoryId = directoryId;
      if (directoryPath) {
        if (directoryId) throw new Error("Provide directoryPath or directoryId, not both.");
        resolvedDirectoryId = (await resolveDestination(client, config.driveId, { directoryPath })).id;
      }
      const page = await client.search(config.driveId, query, {
        directoryId: resolvedDirectoryId,
        queryScope,
        types,
        cursor,
        limit,
      });
      return { query, items: page.data.map(cleanItem), cursor: page.cursor, hasMore: page.has_more ?? false };
    }),
  );

  server.registerTool(
    "kdrive_read_file",
    {
      title: "Read a kDrive file",
      description: "Read a file by path as text, converting supported documents when needed, or return base64 for binary content.",
      inputSchema: { path: path.optional(), fileId: positiveId.optional(), mode: z.enum(["text", "base64"]).default("text") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => tool(async () => {
      const file = await resolveItem(client, config.driveId, input);
      if (file.type === "dir") throw new Error(`${file.path ?? file.name} is a folder, not a readable file.`);
      const result = input.mode === "text"
        ? await client.downloadText(config.driveId, file.id)
        : await client.download(config.driveId, file.id);
      if (result.bytes.byteLength > config.maxReadBytes) {
        throw new Error(`File is ${result.bytes.byteLength} bytes; the read limit is ${config.maxReadBytes} bytes.`);
      }
      return {
        file: cleanItem(file),
        contentType: result.contentType,
        byteLength: result.bytes.byteLength,
        encoding: input.mode === "text" ? "utf8" : "base64",
        ...(input.mode === "text" && "textSource" in result ? { textSource: result.textSource } : {}),
        content: input.mode === "text" ? new TextDecoder().decode(result.bytes) : Buffer.from(result.bytes).toString("base64"),
      };
    }),
  );

  server.registerTool(
    "kdrive_create_directory",
    {
      title: "Create a kDrive folder",
      description: "Create a folder at a full path, or provide a parent path and name. Existing items are never replaced.",
      inputSchema: {
        path: path.optional(),
        parentPath: path.optional(),
        parentId: positiveId.optional(),
        name: z.string().min(1).max(255).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => tool(async () => {
      if (input.path && (input.parentPath || input.parentId || input.name)) {
        throw new Error("Provide a full path, or a parent and name, not both.");
      }
      const destination = input.path ? splitKDrivePath(input.path) : undefined;
      const name = validateName(destination?.name ?? input.name ?? "");
      const parent = await resolveDestination(client, config.driveId, {
        directoryPath: destination?.parentPath ?? input.parentPath,
        directoryId: input.parentId,
      });
      return cleanItem(await client.createDirectory(config.driveId, parent.id, name, input.color));
    }),
  );

  server.registerTool(
    "kdrive_upload_file",
    {
      title: "Save a new file to kDrive",
      description: "Save new UTF-8 or base64 content at a full kDrive path. By default, an existing name causes a safe error instead of replacement.",
      inputSchema: {
        path: path.optional(),
        directoryPath: path.optional(),
        directoryId: positiveId.optional(),
        fileName: z.string().min(1).max(255).optional(),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
        conflict: z.enum(["error", "rename"]).default("error"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => tool(async () => {
      if (input.path && (input.directoryPath || input.directoryId || input.fileName)) {
        throw new Error("Provide a full path, or a destination folder and filename, not both.");
      }
      const destination = input.path ? splitKDrivePath(input.path) : undefined;
      const fileName = validateName(destination?.name ?? input.fileName ?? "");
      const directory = await resolveDestination(client, config.driveId, {
        directoryPath: destination?.parentPath ?? input.directoryPath,
        directoryId: input.directoryId,
      });
      const bytes = input.encoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content, "utf8");
      if (bytes.byteLength > config.maxUploadBytes) {
        throw new Error(`Upload is ${bytes.byteLength} bytes; the connector limit is ${config.maxUploadBytes} bytes.`);
      }
      return cleanItem(await client.upload(config.driveId, { bytes, directoryId: directory.id, fileName, conflict: input.conflict }));
    }),
  );

  server.registerTool(
    "kdrive_rename",
    {
      title: "Rename a kDrive item",
      description: "Rename the specified file or folder after the user requests that exact rename. Path is preferred; name conflicts fail safely.",
      inputSchema: { path: path.optional(), fileId: positiveId.optional(), name: z.string().min(1).max(255) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => tool(async () => {
      const file = await resolveItem(client, config.driveId, input);
      await client.rename(config.driveId, file.id, validateName(input.name));
      return resultAfterMutation(client, config.driveId, file.id);
    }),
  );

  server.registerTool(
    "kdrive_move",
    {
      title: "Move a kDrive item",
      description: "Move a file or folder to a destination folder after the user requests that exact move. Paths are preferred and name conflicts fail safely.",
      inputSchema: {
        path: path.optional(),
        fileId: positiveId.optional(),
        destinationPath: path.optional(),
        destinationDirectoryId: positiveId.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => tool(async () => {
      const file = await resolveItem(client, config.driveId, input);
      const destination = await resolveDestination(client, config.driveId, {
        directoryPath: input.destinationPath,
        directoryId: input.destinationDirectoryId,
      });
      await client.move(config.driveId, file.id, destination.id);
      return resultAfterMutation(client, config.driveId, file.id);
    }),
  );

  server.registerTool(
    "kdrive_overwrite_file",
    {
      title: "Replace a kDrive file's contents",
      description: "Replace the contents of one existing file after the user requests that exact replacement. The connector fetches and enforces the current ETag to prevent a concurrent overwrite.",
      inputSchema: {
        path: path.optional(),
        fileId: positiveId.optional(),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => tool(async () => {
      const file = await resolveItem(client, config.driveId, input);
      if (file.type === "dir") throw new Error(`${file.path ?? file.name} is a folder and cannot be overwritten.`);
      if (!file.etag) throw new Error("kDrive did not return an ETag, so the connector refused to overwrite the file.");
      const bytes = input.encoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content, "utf8");
      if (bytes.byteLength > config.maxUploadBytes) {
        throw new Error(`Upload is ${bytes.byteLength} bytes; the connector limit is ${config.maxUploadBytes} bytes.`);
      }
      await client.upload(config.driveId, { bytes, fileId: file.id, etag: file.etag });
      return resultAfterMutation(client, config.driveId, file.id);
    }),
  );

  server.registerTool(
    "kdrive_trash",
    {
      title: "Move a kDrive item to trash",
      description: "Move the specified file or folder to recoverable kDrive trash after the user requests that exact removal. This does not permanently delete it.",
      inputSchema: { path: path.optional(), fileId: positiveId.optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => tool(async () => {
      const file = await resolveItem(client, config.driveId, input);
      await client.trash(config.driveId, file.id);
      return { trashed: file.path ?? file.name, recoverable: true, restoreId: file.id };
    }),
  );

  server.registerTool(
    "kdrive_restore_from_trash",
    {
      title: "Restore a kDrive item",
      description: "Restore a recoverable item from kDrive trash using the restoreId returned when it was trashed.",
      inputSchema: { restoreId: positiveId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ restoreId }) => tool(async () => {
      await client.restore(config.driveId, restoreId);
      return resultAfterMutation(client, config.driveId, restoreId);
    }),
  );
}
