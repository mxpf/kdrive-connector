import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BINARY_MAX_BYTES, BINARY_TIMEOUT_MS, BinaryTransferError, fetchBinarySource, hashBinary, sourceSize, type BinaryExportReference } from "./binary-transport.js";
import type { KDriveClient, KDriveFile } from "./kdrive-client.js";
import { splitKDrivePath } from "./kdrive-client.js";
import { validateName } from "./safety.js";
import { binaryErrorCode, binaryTrace } from "./binary-diagnostics.js";

export interface BinaryToolConfig {
  driveId: number;
  maxBinaryBytes?: number;
  binarySourceHosts?: readonly string[];
  buildBinaryExport?: (file: KDriveFile, versionId: number | string, digest: { size_bytes: number; sha256: string; trace_id?: string }) => Promise<BinaryExportReference>;
  buildOpenUrl: (file: KDriveFile) => Promise<string> | string;
}

// Exact host observed in a successful host-managed file transfer (2026-09-29).
// Do not broaden this to all regional/shared-storage subdomains.
export const DEFAULT_BINARY_SOURCE_HOSTS = ["files.oaiusercontent.com", "sandbox.openai.com", "sdmntprcentralus.oaiusercontent.com", "sdmntprnorthcentralus.oaiusercontent.com", "sdmntprsoutheastus3.oaiusercontent.com", "sdmntpreastus2.oaiusercontent.com", "oaisdmntprnorthcentralus.blob.core.windows.net"] as const;

export async function uploadedBinaryResult(result: { file: KDriveFile; size_bytes: number; sha256: string }, path: string, buildOpenUrl: BinaryToolConfig["buildOpenUrl"]) {
  let openUrl: string | undefined;
  try { openUrl = await buildOpenUrl(result.file); } catch { /* The upload is already committed. */ }
  return {
    status: "uploaded", path: result.file.path ?? path, file_name: result.file.name,
    mime_type: result.file.mime_type ?? "application/octet-stream",
    size_bytes: result.size_bytes, sha256: result.sha256, resolved_version: result.file.etag ?? null,
    ...(openUrl ? { openUrl } : { warning_code: "OPEN_URL_UNAVAILABLE", warning: "Upload succeeded; its display link is unavailable. Do not repeat the upload." }),
  };
}

export function registerBinaryTools(server: Pick<McpServer, "registerTool">, client: KDriveClient, config: BinaryToolConfig) {
  const maxBytes = config.maxBinaryBytes ?? BINARY_MAX_BYTES;
  const expected = {
    expected_size: z.number().int().positive().max(maxBytes).optional(),
    expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  };
  const path = z.string().min(1).max(4096).describe("Exact natural kDrive path including the destination filename; existing files are never overwritten.");
  const run = async <T extends Record<string, unknown>>(operation: string, fn: (trace: ReturnType<typeof binaryTrace>) => Promise<T>) => {
    const trace = binaryTrace(operation);
    try {
      const result = { ...await fn(trace), trace_id: trace.traceId };
      trace.complete(true);
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      const code = binaryErrorCode(error);
      trace.complete(false, code);
      const result = { error_code: code, trace_id: trace.traceId, stage: trace.stage,
        message: error instanceof BinaryTransferError ? error.message : "Binary transfer failed. No source credentials are included in this error. Check the destination before retrying an upload." };
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  };
  const upload = async (input: { path: string; source_url: string; expected_size?: number; expected_sha256?: string }, trace: ReturnType<typeof binaryTrace>) => {
    const signal = AbortSignal.timeout(BINARY_TIMEOUT_MS);
    const destination = splitKDrivePath(input.path);
    const name = validateName(destination.name);
    const parent = await client.resolvePath(config.driveId, destination.parentPath, signal);
    if (parent.type !== "dir") throw new BinaryTransferError("Binary upload destination must be an existing folder.");
    trace.progress("source_fetch");
    const response = await fetchBinarySource(input.source_url, config.binarySourceHosts ?? DEFAULT_BINARY_SOURCE_HOSTS, signal);
    try {
      const size = sourceSize(response, input.expected_size, maxBytes);
      const result = await client.uploadBinary(config.driveId, {
        body: response.body!, size, fileName: name, directoryId: parent.id,
        expectedSha256: input.expected_sha256, signal,
        onProgress: trace.progress,
      });
      trace.progress("presentation", result.size_bytes);
      return await uploadedBinaryResult(result, input.path, config.buildOpenUrl);
    } finally { await response.body?.cancel().catch(() => undefined); }
  };

  server.registerTool("kdrive_export_file", {
    title: "Export a kDrive binary file reference",
    description: "Primary download action for known PDFs, EPUBs, images, Office documents, archives and other binaries, including files larger than the 2 MiB inline read limit (up to the configured binary limit, normally 100 MiB). Pins the current version and returns filename, MIME, size, version, SHA-256, expires_at, a five-minute HTTPS download_url serving raw bytes, and an MCP resource link. Do not use openUrl or inline base64 as binary transport. Pass the URL only to tools accepting raw HTTPS; otherwise use the host's supported streamed local-file/materialization bridge and native file adapter. A URL/resource link is not automatically a ChatGPT file_id. Refresh expired references by calling this action again and compare resolved_version before continuing. The URL is a private bearer capability: never publish it. Export does not modify kDrive.",
    inputSchema: { path: z.string().min(1).max(4096) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ path }) => {
    const result = await run("kdrive_export_file", async (trace) => {
      if (!config.buildBinaryExport) throw new BinaryTransferError("Binary export requires the HTTPS remote connector; this stdio server has no public download endpoint.");
      const signal = AbortSignal.timeout(BINARY_TIMEOUT_MS);
      const { file, versionId } = await client.resolveBinaryVersion(config.driveId, path, signal);
      if (typeof file.size !== "number" || file.size > maxBytes) throw new BinaryTransferError("Binary export exceeds the configured limit.");
      trace.progress("download");
      const response = await client.downloadVersionStream(config.driveId, file.id, versionId, signal);
      const digest = await hashBinary(response.body!, maxBytes, signal);
      if (digest.size_bytes !== file.size) throw new BinaryTransferError("Pinned version size does not match resolved metadata.");
      trace.progress("reference", digest.size_bytes);
      return { ...await config.buildBinaryExport(file, versionId, { ...digest, trace_id: trace.traceId }) };
    });
    if (!("structuredContent" in result) || !result.structuredContent) return result;
    const ref = result.structuredContent;
    return { ...result, content: [...result.content, {
      type: "resource_link" as const, uri: ref.download_url, name: ref.file_name, mimeType: ref.mime_type,
      size: ref.size_bytes, description: "Raw bytes of the pinned kDrive version; expires in five minutes.",
    }] };
  });
  server.registerTool("kdrive_upload_file_ref", {
    title: "Upload a ChatGPT file to kDrive",
    description: "Preferred binary upload for a generated conversation file or attachment (PNG, PDF, EPUB, ZIP, images, Office and other files). Select the existing file using the host's file-parameter mechanism. The host resolves that selection to a file object before calling this server; do not manually construct an object, download URL, or base64 payload. A host may expose a string selection handle to the model: follow that host's file-input instructions, not the raw server object schema. The server cannot resolve a bare local path, sandbox URI, or file ID itself. If host resolution fails, stop instead of trying alternate string spellings. Streams bytes to the exact destination; no overwrite or automatic rename.",
    inputSchema: {
      path,
      file_ref: z.object({ download_url: z.string().min(1).max(16384), file_id: z.string().min(1), mime_type: z.string().optional(), file_name: z.string().optional() }),
      ...expected,
    },
    _meta: { "openai/fileParams": ["file_ref"] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ file_ref, ...input }) => run("kdrive_upload_file_ref", (trace) => upload({ ...input, source_url: file_ref.download_url }, trace)));
  server.registerTool("kdrive_upload_from_url", {
    title: "Upload a binary HTTPS asset to kDrive",
    description: "Fallback when no native host file reference is available. Streams the exact source response from an administrator-approved HTTPS download host to a conflict-safe kDrive upload. Supply expected_size and expected_sha256 when available; mismatch cancels before finalization. Requires a known size (Content-Length or expected_size). Never substitutes another file or overwrites a destination.",
    inputSchema: { path, source_url: z.string().min(1).max(16384), ...expected },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => run("kdrive_upload_from_url", (trace) => upload(input, trace)));
}
