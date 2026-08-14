#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, requireDriveId } from "./config.js";
import { FileTokenStore, readAccessTokenFromKeychain, TokenProvider } from "./token-store.js";
import { KDriveClient } from "./kdrive-client.js";
import { prepareConfirmation, requireConfirmation, validateName, type SensitiveAction } from "./safety.js";

const config = loadConfig();
const tokenStore = new FileTokenStore(config.tokenFile);
const accessToken = config.accessToken ?? readAccessTokenFromKeychain();
const tokenProvider = new TokenProvider({
  accessToken,
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  tokenUrl: config.tokenUrl,
  redirectUri: config.redirectUri,
  store: tokenStore,
});
const client = new KDriveClient(config, tokenProvider);
const server = new McpServer({ name: "kdrive-connector", version: "0.1.0" });

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

const positiveId = z.number().int().positive();
const fileType = z.enum([
  "archive", "audio", "code", "diagram", "dir", "email", "font", "form", "image", "model",
  "pdf", "presentation", "spreadsheet", "text", "unknown", "video",
]);

server.registerTool(
  "kdrive_connection_status",
  {
    title: "Check kDrive connection",
    description: "Check local connector configuration and, when authenticated, return the selected kDrive metadata.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => tool(async () => {
    const token = await tokenStore.read();
    const authentication = accessToken ? "API access token" : token ? "OAuth token store" : "not authenticated";
    if (!config.driveId) {
      return { connected: false, authentication, tokenFile: config.tokenFile, missing: ["INFOMANIAK_DRIVE_ID"] };
    }
    const drive = await client.getDrive(config.driveId);
    return { connected: true, authentication, drive };
  }),
);

server.registerTool(
  "kdrive_get_file",
  {
    title: "Get kDrive file metadata",
    description: "Return metadata, path, ETag, and capabilities for one kDrive file or folder. Root is file ID 1.",
    inputSchema: { fileId: positiveId.default(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ fileId }) => tool(() => client.getFile(requireDriveId(config), fileId)),
);

server.registerTool(
  "kdrive_list_directory",
  {
    title: "List a kDrive directory",
    description: "List files and folders inside a directory. Use directory ID 1 for the kDrive root and pass cursor to continue.",
    inputSchema: {
      directoryId: positiveId.default(1),
      cursor: z.string().optional(),
      limit: z.number().int().min(5).max(1000).default(100),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ directoryId, cursor, limit }) => tool(() => client.listDirectory(requireDriveId(config), directoryId, { cursor, limit })),
);

server.registerTool(
  "kdrive_search",
  {
    title: "Search kDrive",
    description: "Search recursively by filename and, when supported by the drive, document content. Queries should contain at least 3 characters.",
    inputSchema: {
      query: z.string().min(3).max(500),
      directoryId: positiveId.optional(),
      queryScope: z.enum(["all", "content", "filename"]).default("all"),
      types: z.array(fileType).max(20).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(5).max(1000).default(50),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ query, directoryId, queryScope, types, cursor, limit }) => tool(() =>
    client.search(requireDriveId(config), query, { directoryId, queryScope, types, cursor, limit })),
);

server.registerTool(
  "kdrive_read_file",
  {
    title: "Read a kDrive file",
    description: "Download a file as converted text or as base64. Responses are capped by the connector's configured read limit.",
    inputSchema: {
      fileId: positiveId,
      mode: z.enum(["text", "base64"]).default("text"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ fileId, mode }) => tool(async () => {
    const result = await client.download(requireDriveId(config), fileId, mode === "text" ? { convertAs: "text" } : {});
    if (result.bytes.byteLength > config.maxReadBytes) {
      throw new Error(`File is ${result.bytes.byteLength} bytes; the read limit is ${config.maxReadBytes} bytes.`);
    }
    return {
      fileId,
      contentType: result.contentType,
      byteLength: result.bytes.byteLength,
      encoding: mode === "text" ? "utf8" : "base64",
      content: mode === "text" ? new TextDecoder().decode(result.bytes) : Buffer.from(result.bytes).toString("base64"),
    };
  }),
);

server.registerTool(
  "kdrive_create_directory",
  {
    title: "Create a kDrive folder",
    description: "Create a new folder. This is a non-destructive write but changes the user's kDrive.",
    inputSchema: {
      parentId: positiveId.default(1),
      name: z.string().min(1).max(255),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ parentId, name, color }) => tool(() => client.createDirectory(requireDriveId(config), parentId, validateName(name), color)),
);

server.registerTool(
  "kdrive_upload_file",
  {
    title: "Upload a new kDrive file",
    description: "Upload a new text or base64-encoded file. Existing names are never overwritten; choose error or automatic rename on conflict.",
    inputSchema: {
      directoryId: positiveId.default(1),
      fileName: z.string().min(1).max(255),
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
      conflict: z.enum(["error", "rename"]).default("error"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ directoryId, fileName, content, encoding, conflict }) => tool(async () => {
    const bytes = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
    if (bytes.byteLength > config.maxUploadBytes) {
      throw new Error(`Upload is ${bytes.byteLength} bytes; the connector limit is ${config.maxUploadBytes} bytes.`);
    }
    return client.upload(requireDriveId(config), {
      bytes,
      directoryId,
      fileName: validateName(fileName),
      conflict,
    });
  }),
);

server.registerTool(
  "kdrive_prepare_sensitive_change",
  {
    title: "Prepare a sensitive kDrive change",
    description: "Inspect the current file and return the exact confirmation phrase the user must explicitly approve before rename, move, overwrite, or trash.",
    inputSchema: {
      action: z.enum(["rename", "move", "overwrite", "trash"]),
      fileId: positiveId,
      name: z.string().min(1).max(255).optional(),
      destinationDirectoryId: positiveId.optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ action, fileId, name, destinationDirectoryId }) => tool(async () => {
    const driveId = requireDriveId(config);
    const file = await client.getFile(driveId, fileId);
    const destination = action === "move" && destinationDirectoryId
      ? await client.getFile(driveId, destinationDirectoryId)
      : undefined;
    const prepared = prepareConfirmation(action as SensitiveAction, {
      fileId,
      name: name ? validateName(name) : undefined,
      destinationDirectoryId,
      etag: file.etag,
    });
    return {
      ...prepared,
      file,
      destination,
      instruction: "Show this plan and confirmation phrase to the user. Do not execute the change until the user explicitly approves it.",
    };
  }),
);

server.registerTool(
  "kdrive_rename",
  {
    title: "Rename a kDrive item",
    description: "Rename only after the user explicitly approves the exact phrase returned by kdrive_prepare_sensitive_change.",
    inputSchema: { fileId: positiveId, name: z.string().min(1).max(255), confirmation: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ fileId, name, confirmation }) => tool(async () => {
    const safeName = validateName(name);
    requireConfirmation(confirmation, prepareConfirmation("rename", { fileId, name: safeName }).confirmation);
    return client.rename(requireDriveId(config), fileId, safeName);
  }),
);

server.registerTool(
  "kdrive_move",
  {
    title: "Move a kDrive item",
    description: "Move only after the user explicitly approves the exact phrase returned by kdrive_prepare_sensitive_change. Name conflicts fail safely.",
    inputSchema: { fileId: positiveId, destinationDirectoryId: positiveId, confirmation: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ fileId, destinationDirectoryId, confirmation }) => tool(async () => {
    requireConfirmation(confirmation, prepareConfirmation("move", { fileId, destinationDirectoryId }).confirmation);
    return client.move(requireDriveId(config), fileId, destinationDirectoryId);
  }),
);

server.registerTool(
  "kdrive_overwrite_file",
  {
    title: "Overwrite a kDrive file",
    description: "Create a new version of an existing file only after exact user confirmation. The ETag prevents overwriting a file that changed after review.",
    inputSchema: {
      fileId: positiveId,
      etag: z.string().min(16).max(32),
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
      confirmation: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ fileId, etag, content, encoding, confirmation }) => tool(async () => {
    requireConfirmation(confirmation, prepareConfirmation("overwrite", { fileId, etag }).confirmation);
    const bytes = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
    if (bytes.byteLength > config.maxUploadBytes) {
      throw new Error(`Upload is ${bytes.byteLength} bytes; the connector limit is ${config.maxUploadBytes} bytes.`);
    }
    return client.upload(requireDriveId(config), { bytes, fileId, etag });
  }),
);

server.registerTool(
  "kdrive_trash",
  {
    title: "Move a kDrive item to trash",
    description: "Move a file or folder to recoverable kDrive trash only after the user explicitly approves the exact confirmation phrase.",
    inputSchema: { fileId: positiveId, confirmation: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ fileId, confirmation }) => tool(async () => {
    requireConfirmation(confirmation, prepareConfirmation("trash", { fileId }).confirmation);
    return { trashed: await client.trash(requireDriveId(config), fileId), fileId, recoverable: true };
  }),
);

server.registerTool(
  "kdrive_restore_from_trash",
  {
    title: "Restore a kDrive item",
    description: "Restore a recoverable item from kDrive trash to its prior location.",
    inputSchema: { fileId: positiveId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ fileId }) => tool(() => client.restore(requireDriveId(config), fileId)),
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
