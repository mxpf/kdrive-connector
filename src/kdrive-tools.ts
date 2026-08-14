import { Buffer } from "node:buffer";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  KDriveClient,
  normalizeKDrivePath,
  splitKDrivePath,
  type KDriveFile,
} from "./kdrive-client.js";
import {
  assertOperationPayload,
  assertRestorePayload,
  createOperationPayload,
  createRestorePayload,
  sha256Base64Url,
  signKDrivePayload,
  verifyKDrivePayload,
  type KDriveOperationAction,
  type OperationNonceStore,
  type OperationTokenPayload,
} from "./operation-token.js";
import { validateName } from "./safety.js";

const DEFAULT_OPERATION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_UNDO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const KDRIVE_RESULTS_UI_URI = "ui://kdrive/results-v2.html";

const KDRIVE_RESULTS_UI = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    body { margin: 0; padding: 10px; background: transparent; color: CanvasText; }
    #root { display: grid; gap: 8px; }
    .item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 12px; }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
    .path, .preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 3px; color: color-mix(in srgb, CanvasText 68%, transparent); font-size: 12px; }
    button { appearance: none; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 999px; padding: 7px 11px; background: color-mix(in srgb, CanvasText 7%, transparent); color: inherit; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
    button:hover { background: color-mix(in srgb, CanvasText 12%, transparent); }
    .empty { padding: 12px; color: color-mix(in srgb, CanvasText 68%, transparent); }
  </style>
</head>
<body>
  <div id="root"><div class="empty">Loading kDrive results…</div></div>
  <script>
    const root = document.getElementById("root");
    function render(output) {
      const items = Array.isArray(output?.items) ? output.items : [];
      root.replaceChildren();
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No kDrive results.";
        root.append(empty);
        return;
      }
      for (const item of items.slice(0, 10)) {
        const card = document.createElement("div");
        card.className = "item";
        const copy = document.createElement("div");
        const name = document.createElement("div");
        name.className = "name";
        name.textContent = item.name || "kDrive item";
        copy.append(name);
        if (item.path) {
          const path = document.createElement("div");
          path.className = "path";
          path.textContent = item.path;
          copy.append(path);
        }
        if (item.preview) {
          const preview = document.createElement("div");
          preview.className = "preview";
          preview.textContent = item.preview;
          copy.append(preview);
        }
        const open = document.createElement("button");
        open.type = "button";
        open.textContent = "Open in kDrive";
        open.addEventListener("click", () => {
          if (!item.openUrl) return;
          if (window.openai?.openExternal) window.openai.openExternal({ href: item.openUrl, redirectUrl: false });
          else window.open(item.openUrl, "_blank", "noopener,noreferrer");
        });
        card.append(copy, open);
        root.append(card);
      }
    }
    if (window.openai?.toolOutput) render(window.openai.toolOutput);
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (message?.method === "ui/notifications/tool-result") render(message.params?.structuredContent);
    }, { passive: true });
    window.addEventListener("openai:set_globals", () => render(window.openai?.toolOutput), { passive: true });
  </script>
</body>
</html>`.trim();

export interface KDriveToolConfig {
  driveId: number;
  maxReadBytes: number;
  maxUploadBytes: number;
  operationSecret: string;
  nonceStore: OperationNonceStore;
  buildOpenUrl: (file: KDriveFile) => Promise<string> | string;
  connectionStatus: () => Promise<unknown>;
  operationTtlMs?: number;
  undoTtlMs?: number;
}

function markdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

interface OpenLink {
  url: string;
  name: string;
  path?: string;
  mimeType?: string;
}

function collectOpenLinks(value: unknown, links: OpenLink[] = []): OpenLink[] {
  if (Array.isArray(value)) {
    for (const item of value) collectOpenLinks(item, links);
    return links;
  }
  if (!value || typeof value !== "object") return links;

  const record = value as Record<string, unknown>;
  if (typeof record.openUrl === "string") {
    links.push({
      url: record.openUrl,
      name: typeof record.name === "string" ? record.name : "kDrive item",
      ...(typeof record.path === "string" ? { path: record.path } : {}),
      ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
    });
  }
  for (const [key, item] of Object.entries(record)) {
    if (key !== "openUrl") collectOpenLinks(item, links);
  }
  return links;
}

function jsonContent(value: unknown) {
  const links = [...new Map(collectOpenLinks(value).map((link) => [link.url, link])).values()];
  const linkSection = links.length > 0
    ? `\n\nClickable kDrive links (preserve these exact Markdown links in the user-facing response):\n${links.map((link) => `- [${markdownLabel(`Open ${link.name} in kDrive`)}](${link.url})`).join("\n")}`
    : "";
  return {
    structuredContent: value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : { value },
    content: [
      { type: "text" as const, text: `${JSON.stringify(value, null, 2)}${linkSection}` },
      ...links.map((link) => ({
        type: "resource_link" as const,
        uri: link.url,
        name: link.name,
        title: `Open ${link.name} in kDrive`,
        ...(link.path ? { description: link.path } : {}),
        ...(link.mimeType ? { mimeType: link.mimeType } : {}),
      })),
    ],
  };
}

function errorContent(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function tool<T>(handler: () => Promise<T>) {
  return handler().then(jsonContent).catch(errorContent);
}

function displayPath(file: KDriveFile): string {
  return normalizeKDrivePath(file.path ?? `/${file.name}`);
}

async function cleanItem(file: KDriveFile, config: KDriveToolConfig) {
  return {
    name: file.name,
    path: displayPath(file),
    type: file.type,
    status: file.status,
    size: file.size,
    mimeType: file.mime_type,
    lastModifiedAt: file.last_modified_at,
    openUrl: await config.buildOpenUrl(file),
  };
}

async function cleanItems(files: KDriveFile[], config: KDriveToolConfig) {
  return Promise.all(files.map((file) => cleanItem(file, config)));
}

async function resolveItem(
  client: KDriveClient,
  driveId: number,
  pathValue: string | undefined,
  options: { defaultToRoot?: boolean; requireDirectory?: boolean } = {},
): Promise<KDriveFile> {
  let file: KDriveFile;
  if (pathValue) file = await client.resolvePath(driveId, pathValue);
  else if (options.defaultToRoot) file = await client.getFile(driveId, 1);
  else throw new Error("Provide the item's kDrive path.");
  if (options.requireDirectory && file.type !== "dir") {
    throw new Error(`${displayPath(file)} is not a folder.`);
  }
  return file;
}

async function resolveDestination(
  client: KDriveClient,
  driveId: number,
  directoryPath?: string,
): Promise<KDriveFile> {
  return resolveItem(client, driveId, directoryPath, { defaultToRoot: true, requireDirectory: true });
}

async function resultAfterMutation(client: KDriveClient, config: KDriveToolConfig, fileId: number) {
  return cleanItem(await client.getFile(config.driveId, fileId), config);
}

function contentBytes(content: string, encoding: "utf8" | "base64"): Uint8Array {
  return new Uint8Array(Buffer.from(content, encoding === "base64" ? "base64" : "utf8"));
}

function assertUploadSize(bytes: Uint8Array, maxUploadBytes: number): void {
  if (bytes.byteLength > maxUploadBytes) {
    throw new Error(`Upload is ${bytes.byteLength} bytes; the connector limit is ${maxUploadBytes} bytes.`);
  }
}

function assertMutableItem(file: KDriveFile): void {
  if (file.id === 1) throw new Error("The kDrive root cannot be changed by this tool.");
}

async function previewFile(
  client: KDriveClient,
  config: KDriveToolConfig,
  file: KDriveFile,
  characters: number,
): Promise<{ preview?: string; previewTruncated?: boolean }> {
  if (file.type === "dir") return { preview: "Folder", previewTruncated: false };
  const metadataPreview = [
    file.mime_type ?? file.extension_type ?? "File",
    file.size === undefined ? undefined : `${file.size.toLocaleString("en-US")} bytes`,
  ].filter(Boolean).join(" · ");
  if (file.size !== undefined && file.size > config.maxReadBytes) {
    return { preview: metadataPreview, previewTruncated: false };
  }
  try {
    const result = await client.downloadText(config.driveId, file.id);
    if (result.bytes.byteLength > config.maxReadBytes) return {};
    const text = new TextDecoder().decode(result.bytes).replace(/\0/g, "").trim();
    if (!text) return { preview: metadataPreview, previewTruncated: false };
    return {
      preview: text.slice(0, characters),
      previewTruncated: text.length > characters,
    };
  } catch {
    return { preview: metadataPreview, previewTruncated: false };
  }
}

async function verifyPreparedOperation(
  client: KDriveClient,
  config: KDriveToolConfig,
  action: KDriveOperationAction,
  pathValue: string,
  operationToken: string,
): Promise<{ file: KDriveFile; payload: OperationTokenPayload }> {
  const payload = await verifyKDrivePayload(config.operationSecret, operationToken);
  assertOperationPayload(payload, action, config.driveId);
  const normalizedPath = normalizeKDrivePath(pathValue);
  if (normalizedPath !== payload.sourcePath) {
    throw new Error("The path does not match the prepared kDrive action.");
  }
  const file = await client.resolvePath(config.driveId, normalizedPath);
  if (file.id !== payload.sourceId || displayPath(file) !== payload.sourcePath) {
    throw new Error("The target changed after this kDrive action was prepared. Prepare it again.");
  }
  if (payload.sourceEtag && file.etag !== payload.sourceEtag) {
    throw new Error("The target changed after this kDrive action was prepared. Prepare it again.");
  }
  return { file, payload };
}

async function consumePreparedOperation(config: KDriveToolConfig, payload: OperationTokenPayload): Promise<void> {
  if (!await config.nonceStore.consume(payload.jti, Date.now())) {
    throw new Error("This prepared kDrive action was already used or expired. Prepare it again.");
  }
}

const kdrivePath = z.string().min(1).max(4096);
const operationToken = z.string().min(40).max(4096);
const fileType = z.enum([
  "archive", "audio", "code", "diagram", "dir", "email", "file", "font", "form", "image", "model",
  "pdf", "presentation", "spreadsheet", "text", "unknown", "video",
]);
const resultItemSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.string(),
  status: z.string().optional(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
  lastModifiedAt: z.number().optional(),
  openUrl: z.string().url(),
  preview: z.string().optional(),
  previewTruncated: z.boolean().optional(),
});
const resultsUiMeta = {
  ui: { resourceUri: KDRIVE_RESULTS_UI_URI, visibility: ["model", "app"] },
  "openai/outputTemplate": KDRIVE_RESULTS_UI_URI,
  "openai/widgetAccessible": true,
  "openai/toolInvocation/invoking": "Searching kDrive…",
  "openai/toolInvocation/invoked": "kDrive results ready",
};

export function registerKDriveTools(
  server: Pick<McpServer, "registerTool">,
  client: KDriveClient,
  config: KDriveToolConfig,
): void {
  const resourceServer = server as unknown as {
    registerResource: (
      name: string,
      uri: string,
      metadata: Record<string, never>,
      read: () => Promise<Record<string, unknown>>,
    ) => unknown;
  };
  resourceServer.registerResource("kdrive-results", KDRIVE_RESULTS_UI_URI, {}, async () => ({
    contents: [{
      uri: KDRIVE_RESULTS_UI_URI,
      mimeType: "text/html;profile=mcp-app",
      text: KDRIVE_RESULTS_UI,
      _meta: {
        ui: {
          prefersBorder: true,
          domain: "https://kdrive-connector-mcp.maxpfennighaus.workers.dev",
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetDescription": "A compact list of kDrive files with paths, previews, and Open in kDrive buttons.",
        "openai/widgetPrefersBorder": true,
        "openai/widgetDomain": "https://kdrive-connector-mcp.maxpfennighaus.workers.dev",
        "openai/widgetCSP": {
          connect_domains: [],
          resource_domains: [],
          redirect_domains: [
            "https://kdrive-connector-mcp.maxpfennighaus.workers.dev",
            "https://ksuite.infomaniak.com",
          ],
        },
      },
    }],
  }));

  server.registerTool(
    "kdrive_connection_status",
    {
      title: "Check kDrive connection",
      description: "Use when the user asks whether kDrive is connected. Returns a concise status without internal IDs or credentials.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => tool(config.connectionStatus),
  );

  server.registerTool(
    "kdrive_get_file",
    {
      title: "Get a kDrive file or folder",
      description: "Use for details about a known kDrive path such as /Private/Invoices/report.pdf. Omit path only for the kDrive root. Do not use for Google Drive or local files.",
      inputSchema: { path: kdrivePath.optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ path }) => tool(async () => cleanItem(
      await resolveItem(client, config.driveId, path, { defaultToRoot: true }),
      config,
    )),
  );

  server.registerTool(
    "kdrive_list_directory",
    {
      title: "List a kDrive folder",
      description: "Use to browse an Infomaniak kDrive folder by natural path. Omit directoryPath for the root and pass cursor only to continue a prior page.",
      inputSchema: {
        directoryPath: kdrivePath.optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(5).max(1000).default(100),
      },
      outputSchema: {
        folder: z.string(),
        items: z.array(resultItemSchema),
        cursor: z.string().optional(),
        hasMore: z.boolean(),
      },
      _meta: resultsUiMeta,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ directoryPath, cursor, limit }) => tool(async () => {
      const directory = await resolveDestination(client, config.driveId, directoryPath);
      const page = await client.listDirectory(config.driveId, directory.id, { cursor, limit });
      return {
        folder: displayPath(directory),
        items: await cleanItems(page.data, config),
        cursor: page.cursor,
        hasMore: page.has_more ?? false,
      };
    }),
  );

  server.registerTool(
    "kdrive_search",
    {
      title: "Search kDrive files",
      description: "Use when the user asks to find something in kDrive or refers to files under a known kDrive path. Searches filenames and supported document content, returns paths, short previews, and Open in kDrive links. Do not use for another storage service unless the user identifies kDrive.",
      inputSchema: {
        query: z.string().min(3).max(500),
        directoryPath: kdrivePath.optional(),
        queryScope: z.enum(["all", "content", "filename"]).default("all"),
        types: z.array(fileType).max(20).optional(),
        includePreviews: z.boolean().default(true),
        previewCharacters: z.number().int().min(100).max(2000).default(400),
        previewLimit: z.number().int().min(1).max(10).default(5),
        cursor: z.string().optional(),
        limit: z.number().int().min(5).max(1000).default(50),
      },
      outputSchema: {
        query: z.string(),
        searchedFolder: z.string(),
        items: z.array(resultItemSchema),
        cursor: z.string().optional(),
        hasMore: z.boolean(),
      },
      _meta: resultsUiMeta,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({
      query,
      directoryPath,
      queryScope,
      types,
      includePreviews,
      previewCharacters,
      previewLimit,
      cursor,
      limit,
    }) => tool(async () => {
      const directory = directoryPath
        ? await resolveDestination(client, config.driveId, directoryPath)
        : undefined;
      const page = await client.search(config.driveId, query, {
        directoryId: directory?.id,
        queryScope,
        types,
        cursor,
        limit,
      });
      const items = await Promise.all(page.data.map(async (file, index) => ({
        ...await cleanItem(file, config),
        ...(includePreviews && index < previewLimit
          ? await previewFile(client, config, file, previewCharacters)
          : {}),
      })));
      return {
        query,
        searchedFolder: directory ? displayPath(directory) : "/",
        items,
        cursor: page.cursor,
        hasMore: page.has_more ?? false,
      };
    }),
  );

  server.registerTool(
    "kdrive_read_file",
    {
      title: "Read a kDrive file",
      description: "Use to read or summarize one known kDrive file by path. Returns converted text when supported or base64 only when explicitly requested.",
      inputSchema: { path: kdrivePath, mode: z.enum(["text", "base64"]).default("text") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ path, mode }) => tool(async () => {
      const file = await resolveItem(client, config.driveId, path);
      if (file.type === "dir") throw new Error(`${displayPath(file)} is a folder, not a readable file.`);
      const result = mode === "text"
        ? await client.downloadText(config.driveId, file.id)
        : await client.download(config.driveId, file.id);
      if (result.bytes.byteLength > config.maxReadBytes) {
        throw new Error(`File is ${result.bytes.byteLength} bytes; the read limit is ${config.maxReadBytes} bytes.`);
      }
      return {
        file: await cleanItem(file, config),
        contentType: result.contentType,
        byteLength: result.bytes.byteLength,
        encoding: mode === "text" ? "utf8" : "base64",
        ...(mode === "text" && "textSource" in result ? { textSource: result.textSource } : {}),
        content: mode === "text" ? new TextDecoder().decode(result.bytes) : Buffer.from(result.bytes).toString("base64"),
      };
    }),
  );

  server.registerTool(
    "kdrive_create_directory",
    {
      title: "Create a kDrive folder",
      description: "Use when the user asks to create a new folder at an exact kDrive path. Existing items are never replaced.",
      inputSchema: {
        path: kdrivePath.optional(),
        parentPath: kdrivePath.optional(),
        name: z.string().min(1).max(255).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => tool(async () => {
      if (input.path && (input.parentPath || input.name)) {
        throw new Error("Provide a full path, or a parent path and name, not both.");
      }
      const destination = input.path ? splitKDrivePath(input.path) : undefined;
      const name = validateName(destination?.name ?? input.name ?? "");
      const parent = await resolveDestination(client, config.driveId, destination?.parentPath ?? input.parentPath);
      return cleanItem(await client.createDirectory(config.driveId, parent.id, name, input.color), config);
    }),
  );

  server.registerTool(
    "kdrive_upload_file",
    {
      title: "Save a new file to kDrive",
      description: "Use when the user asks to save or upload new content to an exact kDrive path. Existing names fail safely unless the user requests an automatically renamed copy.",
      inputSchema: {
        path: kdrivePath.optional(),
        directoryPath: kdrivePath.optional(),
        fileName: z.string().min(1).max(255).optional(),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
        conflict: z.enum(["error", "rename"]).default("error"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => tool(async () => {
      if (input.path && (input.directoryPath || input.fileName)) {
        throw new Error("Provide a full path, or a destination folder and filename, not both.");
      }
      const destination = input.path ? splitKDrivePath(input.path) : undefined;
      const fileName = validateName(destination?.name ?? input.fileName ?? "");
      const directory = await resolveDestination(client, config.driveId, destination?.parentPath ?? input.directoryPath);
      const bytes = contentBytes(input.content, input.encoding);
      assertUploadSize(bytes, config.maxUploadBytes);
      return cleanItem(await client.upload(config.driveId, {
        bytes,
        directoryId: directory.id,
        fileName,
        conflict: input.conflict,
      }), config);
    }),
  );

  server.registerTool(
    "kdrive_prepare_change",
    {
      title: "Prepare a safe kDrive change",
      description: "Internal prerequisite for rename, move, overwrite, or trash. Resolve the exact paths and mint a short-lived target-bound token, then immediately call the matching write tool with the same readable arguments. Do not show the token or ask the user to copy it; the host supplies the normal approval UI for the write.",
      inputSchema: {
        action: z.enum(["rename", "move", "overwrite", "trash"]),
        path: kdrivePath,
        name: z.string().min(1).max(255).optional(),
        destinationPath: kdrivePath.optional(),
        content: z.string().optional(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, path, name, destinationPath, content, encoding }) => tool(async () => {
      const file = await client.resolvePath(config.driveId, path);
      assertMutableItem(file);
      const sourcePath = displayPath(file);
      const ttlMs = config.operationTtlMs ?? DEFAULT_OPERATION_TTL_MS;
      const common = {
        action,
        driveId: config.driveId,
        sourceId: file.id,
        sourcePath,
        ...(file.etag ? { sourceEtag: file.etag } : {}),
      };
      let payload: OperationTokenPayload;
      let summary: string;

      if (action === "rename") {
        if (!name || destinationPath || content !== undefined) throw new Error("A rename requires only path and name.");
        const safeName = validateName(name);
        payload = createOperationPayload({ ...common, action, name: safeName }, ttlMs);
        summary = `Rename ${sourcePath} to ${safeName}?`;
      } else if (action === "move") {
        if (!destinationPath || name || content !== undefined) throw new Error("A move requires only path and destinationPath.");
        const destination = await resolveDestination(client, config.driveId, destinationPath);
        const resolvedDestinationPath = displayPath(destination);
        payload = createOperationPayload({
          ...common,
          action,
          destinationId: destination.id,
          destinationPath: resolvedDestinationPath,
        }, ttlMs);
        summary = `Move ${sourcePath} to ${resolvedDestinationPath}?`;
      } else if (action === "overwrite") {
        if (file.type === "dir") throw new Error(`${sourcePath} is a folder and cannot be overwritten.`);
        if (content === undefined || name || destinationPath) throw new Error("An overwrite requires only path, content, and encoding.");
        if (!file.etag) throw new Error("kDrive returned no current file version, so the connector refused to prepare an overwrite.");
        const bytes = contentBytes(content, encoding);
        assertUploadSize(bytes, config.maxUploadBytes);
        payload = createOperationPayload({
          ...common,
          action,
          contentDigest: await sha256Base64Url(bytes),
        }, ttlMs);
        summary = `Replace the contents of ${sourcePath}?`;
      } else {
        if (name || destinationPath || content !== undefined) throw new Error("Trash requires only path.");
        payload = createOperationPayload({ ...common, action }, ttlMs);
        summary = `Move ${sourcePath} to recoverable kDrive trash?`;
      }

      await config.nonceStore.issue(payload.jti, payload.expiresAt);
      return {
        prepared: true,
        action,
        summary,
        sourcePath,
        ...(payload.name ? { name: payload.name } : {}),
        ...(payload.destinationPath ? { destinationPath: payload.destinationPath } : {}),
        operationToken: await signKDrivePayload(config.operationSecret, payload),
        expiresAt: new Date(payload.expiresAt).toISOString(),
      };
    }),
  );

  server.registerTool(
    "kdrive_rename",
    {
      title: "Rename a kDrive item",
      description: "Rename one exact kDrive path. First call kdrive_prepare_change with action rename, then pass its opaque operationToken here with the same path and name. Never ask the user to handle the token.",
      inputSchema: { path: kdrivePath, name: z.string().min(1).max(255), operationToken },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ path, name, operationToken }) => tool(async () => {
      const safeName = validateName(name);
      const { file, payload } = await verifyPreparedOperation(client, config, "rename", path, operationToken);
      if (payload.name !== safeName) throw new Error("The new name does not match the prepared kDrive action.");
      await consumePreparedOperation(config, payload);
      await client.rename(config.driveId, file.id, safeName);
      return resultAfterMutation(client, config, file.id);
    }),
  );

  server.registerTool(
    "kdrive_move",
    {
      title: "Move a kDrive item",
      description: "Move one exact kDrive path to one exact destination folder. First call kdrive_prepare_change with action move, then pass its opaque operationToken here. Never ask the user to handle the token.",
      inputSchema: { path: kdrivePath, destinationPath: kdrivePath, operationToken },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ path, destinationPath, operationToken }) => tool(async () => {
      const { file, payload } = await verifyPreparedOperation(client, config, "move", path, operationToken);
      const destination = await resolveDestination(client, config.driveId, destinationPath);
      if (payload.destinationId !== destination.id || payload.destinationPath !== displayPath(destination)) {
        throw new Error("The destination does not match the prepared kDrive action.");
      }
      await consumePreparedOperation(config, payload);
      await client.move(config.driveId, file.id, destination.id);
      return resultAfterMutation(client, config, file.id);
    }),
  );

  server.registerTool(
    "kdrive_overwrite_file",
    {
      title: "Replace a kDrive file's contents",
      description: "Replace one existing kDrive file with exact content. First call kdrive_prepare_change with action overwrite and the same content. The connector privately enforces the prepared file version and content digest; never ask the user for an ETag or token.",
      inputSchema: {
        path: kdrivePath,
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
        operationToken,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ path, content, encoding, operationToken }) => tool(async () => {
      const { file, payload } = await verifyPreparedOperation(client, config, "overwrite", path, operationToken);
      if (file.type === "dir") throw new Error(`${displayPath(file)} is a folder and cannot be overwritten.`);
      if (!file.etag || !payload.sourceEtag) throw new Error("The current file version is unavailable.");
      const bytes = contentBytes(content, encoding);
      assertUploadSize(bytes, config.maxUploadBytes);
      if (payload.contentDigest !== await sha256Base64Url(bytes)) {
        throw new Error("The replacement content does not match the prepared kDrive action.");
      }
      await consumePreparedOperation(config, payload);
      await client.upload(config.driveId, { bytes, fileId: file.id, etag: payload.sourceEtag });
      return resultAfterMutation(client, config, file.id);
    }),
  );

  server.registerTool(
    "kdrive_trash",
    {
      title: "Move a kDrive item to trash",
      description: "Move one exact kDrive path to recoverable trash. First call kdrive_prepare_change with action trash, then pass its opaque operationToken here. This never permanently deletes the item.",
      inputSchema: { path: kdrivePath, operationToken },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ path, operationToken }) => tool(async () => {
      const { file, payload } = await verifyPreparedOperation(client, config, "trash", path, operationToken);
      const undoPayload = createRestorePayload({
        driveId: config.driveId,
        fileId: file.id,
        originalPath: displayPath(file),
      }, config.undoTtlMs ?? DEFAULT_UNDO_TTL_MS);
      const undoToken = await signKDrivePayload(config.operationSecret, undoPayload);
      await consumePreparedOperation(config, payload);
      await client.trash(config.driveId, file.id);
      return {
        trashedPath: displayPath(file),
        recoverable: true,
        undoToken,
        undoAvailableUntil: new Date(undoPayload.expiresAt).toISOString(),
      };
    }),
  );

  server.registerTool(
    "kdrive_restore_from_trash",
    {
      title: "Undo a kDrive trash action",
      description: "Restore a recoverable item using the opaque undoToken returned by kdrive_trash. Keep the token internal and report the restored path, not implementation identifiers.",
      inputSchema: { undoToken: operationToken },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ undoToken }) => tool(async () => {
      const payload = await verifyKDrivePayload(config.operationSecret, undoToken);
      assertRestorePayload(payload, config.driveId);
      await client.restore(config.driveId, payload.fileId);
      return resultAfterMutation(client, config, payload.fileId);
    }),
  );
}
