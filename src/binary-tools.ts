import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BINARY_MAX_BYTES, BINARY_TIMEOUT_MS, BinaryTransferError, fetchBinarySource, hashBinary, sourceSize, type BinaryExportReference } from "./binary-transport.js";
import type { KDriveClient, KDriveFile } from "./kdrive-client.js";
import { splitKDrivePath } from "./kdrive-client.js";
import { validateName } from "./safety.js";

export interface BinaryToolConfig {
  driveId: number;
  maxBinaryBytes?: number;
  binarySourceHosts?: readonly string[];
  buildBinaryExport?: (file: KDriveFile, versionId: number | string, digest: { size_bytes: number; sha256: string }) => Promise<BinaryExportReference>;
  buildOpenUrl: (file: KDriveFile) => Promise<string> | string;
}

export const DEFAULT_BINARY_SOURCE_HOSTS = ["files.oaiusercontent.com", "sandbox.openai.com"] as const;

export function registerBinaryTools(server: Pick<McpServer, "registerTool">, client: KDriveClient, config: BinaryToolConfig) {
  const maxBytes = config.maxBinaryBytes ?? BINARY_MAX_BYTES;
  const expected = {
    expected_size: z.number().int().positive().max(maxBytes).optional(),
    expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  };
  const path = z.string().min(1).max(4096).describe("Exact natural kDrive path including the destination filename; existing files are never overwritten.");
  const run = async <T extends Record<string, unknown>>(fn: () => Promise<T>) => {
    try {
      const result = await fn();
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof BinaryTransferError ? error.message : "Binary transfer failed. No source credentials are included in this error. Check the destination before retrying an upload." }] };
    }
  };
  const upload = async (input: { path: string; source_url: string; expected_size?: number; expected_sha256?: string }) => {
    const signal = AbortSignal.timeout(BINARY_TIMEOUT_MS);
    const destination = splitKDrivePath(input.path);
    const name = validateName(destination.name);
    const parent = await client.resolvePath(config.driveId, destination.parentPath, signal);
    if (parent.type !== "dir") throw new BinaryTransferError("Binary upload destination must be an existing folder.");
    const response = await fetchBinarySource(input.source_url, config.binarySourceHosts ?? DEFAULT_BINARY_SOURCE_HOSTS, signal);
    try {
      const size = sourceSize(response, input.expected_size, maxBytes);
      const result = await client.uploadBinary(config.driveId, {
        body: response.body!, size, fileName: name, directoryId: parent.id,
        expectedSha256: input.expected_sha256, signal,
      });
      return {
        path: result.file.path ?? input.path,
        file_name: result.file.name,
        mime_type: result.file.mime_type ?? "application/octet-stream",
        size_bytes: result.size_bytes, sha256: result.sha256,
        resolved_version: result.file.etag ?? null,
        openUrl: await config.buildOpenUrl(result.file),
      };
    } finally { await response.body?.cancel().catch(() => undefined); }
  };

  server.registerTool("kdrive_export_file", {
    title: "Export a kDrive binary file reference",
    description: "Preferred for handing a known PDF, EPUB, image, archive or other binary to another tool. Pins the current version and returns metadata, SHA-256 and a short-lived HTTPS URL serving raw bytes, plus an MCP resource link. Do not use openUrl or inline base64 as binary transport. The URL is a private bearer capability: pass only to the intended tool, never publish it. Export does not modify kDrive.",
    inputSchema: { path: z.string().min(1).max(4096) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ path }) => {
    const result = await run(async () => {
      if (!config.buildBinaryExport) throw new BinaryTransferError("Binary export requires the HTTPS remote connector; this stdio server has no public download endpoint.");
      const signal = AbortSignal.timeout(BINARY_TIMEOUT_MS);
      const { file, versionId } = await client.resolveBinaryVersion(config.driveId, path, signal);
      if (typeof file.size !== "number" || file.size > maxBytes) throw new BinaryTransferError("Binary export exceeds the configured limit.");
      const response = await client.downloadVersionStream(config.driveId, file.id, versionId, signal);
      const digest = await hashBinary(response.body!, maxBytes, signal);
      if (digest.size_bytes !== file.size) throw new BinaryTransferError("Pinned version size does not match resolved metadata.");
      return { ...await config.buildBinaryExport(file, versionId, digest) };
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
    description: "Preferred binary upload for generated files and conversation attachments (PDF, EPUB, ZIP, images, Office and other files). Pass the native host file object; the server streams its download_url into a conflict-safe kDrive upload. Never read or base64-encode the bytes in model context. Bare sandbox paths or file IDs are not remotely downloadable. No overwrite or automatic rename.",
    inputSchema: {
      path,
      file_ref: z.object({ download_url: z.string().min(1).max(16384), file_id: z.string().min(1), mime_type: z.string().optional(), file_name: z.string().optional() }),
      ...expected,
    },
    _meta: { "openai/fileParams": ["file_ref"] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ file_ref, ...input }) => run(() => upload({ ...input, source_url: file_ref.download_url })));
  server.registerTool("kdrive_upload_from_url", {
    title: "Upload a binary HTTPS asset to kDrive",
    description: "Fallback when no native host file reference is available. Streams the exact source response from an administrator-approved HTTPS download host to a conflict-safe kDrive upload. Supply expected_size and expected_sha256 when available; mismatch cancels before finalization. Requires a known size (Content-Length or expected_size). Never substitutes another file or overwrites a destination.",
    inputSchema: { path, source_url: z.string().min(1).max(16384), ...expected },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => run(() => upload(input)));
}
