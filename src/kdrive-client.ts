import { createHash, randomUUID } from "node:crypto";
import { BINARY_CHUNK_BYTES, BinaryTransferError, binaryChunks, fetchBinarySource } from "./binary-transport.js";
import type { AppConfig } from "./config.js";
import { KDriveApiError } from "./errors.js";
import {
  logOperationalInfo,
  operationalErrorCode,
  operationalResult,
} from "./operational-logging.js";
import type { TokenProvider } from "./token-store.js";

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;

export interface KDriveFile {
  id: number;
  name: string;
  type: string;
  status?: string;
  visibility?: string;
  drive_id?: number;
  parent_id?: number;
  path?: string;
  size?: number;
  mime_type?: string;
  extension_type?: string;
  etag?: string;
  last_modified_at?: number;
  updated_at?: number;
  capabilities?: Record<string, boolean>;
  [key: string]: unknown;
}

export interface CursorPage<T> {
  data: T[];
  cursor?: string;
  has_more?: boolean;
  response_at?: number;
}

interface ApiEnvelope<T> {
  result: "success" | "error" | "asynchronous";
  data?: T;
  cursor?: string | null;
  has_more?: boolean;
  response_at?: number;
  error?: {
    code?: string;
    description?: string;
    context?: unknown;
    errors?: unknown[];
  };
}

interface RequestOptions {
  signal?: AbortSignal;
  redirect?: "follow" | "error" | "manual";
  retry401?: boolean;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  json?: unknown;
  body?: Uint8Array;
  diagnostics?: {
    operation:
      | "get_drive"
      | "get_file"
      | "list_directory"
      | "search"
      | "download"
      | "preview"
      | "create_directory"
      | "upload"
      | "rename"
      | "move"
      | "trash"
      | "restore";
    traceId?: string;
  };
}

export interface DownloadResult {
  bytes: Uint8Array;
  contentType: string;
}

export interface TextDownloadResult extends DownloadResult {
  textSource: "raw" | "converted";
}

export function normalizeKDrivePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("A kDrive path is required.");
  if (trimmed.includes("\\")) throw new Error("Use forward slashes in kDrive paths.");
  const segments = trimmed.split("/").filter(Boolean).map((segment) => segment.normalize("NFC"));
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("kDrive paths cannot contain '.' or '..' segments.");
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function splitKDrivePath(path: string): { parentPath: string; name: string } {
  const normalized = normalizeKDrivePath(path);
  if (normalized === "/") throw new Error("The kDrive root cannot be used as an item destination.");
  const segments = normalized.slice(1).split("/");
  const name = segments.pop();
  if (!name) throw new Error("The destination path must include a file or folder name.");
  return {
    parentPath: segments.length === 0 ? "/" : `/${segments.join("/")}`,
    name,
  };
}

function isTextContentType(contentType: string | undefined): boolean {
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mimeType) return false;
  return mimeType.startsWith("text/")
    || mimeType === "application/json"
    || mimeType === "application/javascript"
    || mimeType === "application/xml"
    || mimeType.endsWith("+json")
    || mimeType.endsWith("+xml");
}

class ResponseBodyLimitError extends Error {}

async function readResponseBytes(response: Response, maxBytes?: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (maxBytes !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseBodyLimitError(`The kDrive response exceeds the ${maxBytes}-byte read limit.`);
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (maxBytes !== undefined && totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseBodyLimitError(`The kDrive response exceeds the ${maxBytes}-byte read limit.`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class KDriveClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: AppConfig,
    private readonly tokenProvider: Pick<TokenProvider, "getAccessToken">,
    fetchImpl: typeof fetch = fetch,
  ) {
    // Keep platform fetch functions as plain calls. Invoking a stored native
    // fetch as `this.fetchImpl(...)` supplies KDriveClient as its receiver,
    // which Cloudflare Workers rejects with an "Illegal invocation" error.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }

  private buildUrl(endpoint: string, query: Record<string, QueryValue> = {}): URL {
    const url = new URL(endpoint, this.config.apiBaseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  private async rawRequest(endpoint: string, options: RequestOptions = {}): Promise<Response> {
    const startedAt = Date.now();
    const traceId = options.diagnostics?.traceId ?? randomUUID();
    let refreshedAccessToken = false;
    const makeRequest = async (forceRefresh = false): Promise<Response> => {
      const token = await this.tokenProvider.getAccessToken(forceRefresh);
      const headers = new Headers({ accept: "application/json", authorization: `Bearer ${token}`, ...options.headers });
      let body: BodyInit | undefined;
      if (options.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(options.json);
      } else if (options.body) {
        headers.set("content-type", "application/octet-stream");
        body = Buffer.from(options.body);
      }
      return this.fetchImpl(this.buildUrl(endpoint, options.query), {
        method: options.method ?? "GET",
        headers,
        body,
        signal: options.signal,
        redirect: options.redirect,
      });
    };

    let response = await makeRequest(false);
    if (response.status === 401 && options.retry401 !== false) {
      refreshedAccessToken = true;
      response = await makeRequest(true);
    }
    if (options.diagnostics) {
      logOperationalInfo({
        event: "kdrive.api_response",
        operation: options.diagnostics.operation,
        traceId,
        durationMs: Date.now() - startedAt,
        httpStatus: response.status,
        ok: response.ok,
        refreshedAccessToken,
      });
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as ApiEnvelope<unknown> | undefined;
      const message = payload?.error?.description ?? `Infomaniak API request failed with HTTP ${response.status}.`;
      throw new KDriveApiError(message, response.status, payload?.error?.code, payload?.error);
    }
    return response;
  }

  private async jsonRequest<T>(endpoint: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
    if (options.diagnostics && !options.diagnostics.traceId) options.diagnostics.traceId = randomUUID();
    const response = await this.rawRequest(endpoint, options);
    const payload = (await response.json()) as ApiEnvelope<T>;
    if (options.diagnostics) {
      logOperationalInfo({
        event: "kdrive.api_envelope",
        operation: options.diagnostics.operation,
        traceId: options.diagnostics.traceId,
        result: operationalResult(payload?.result),
        hasData: payload?.data !== undefined && payload?.data !== null,
        dataType: Array.isArray(payload?.data) ? "array" : typeof payload?.data,
        errorCode: operationalErrorCode(payload?.error?.code),
      });
    }
    if (payload.result === "error") {
      throw new KDriveApiError(
        payload.error?.description ?? "Infomaniak returned an API error.",
        response.status,
        payload.error?.code,
        payload.error,
      );
    }
    return payload;
  }

  async getDrive(driveId: number): Promise<Record<string, unknown>> {
    const response = await this.jsonRequest<Record<string, unknown>>(`/2/drive/${driveId}`, {
      query: { with: "capabilities,rights,quota" },
      diagnostics: { operation: "get_drive" },
    });
    return response.data ?? {};
  }

  async getFile(driveId: number, fileId: number, signal?: AbortSignal): Promise<KDriveFile> {
    const response = await this.jsonRequest<KDriveFile>(`/3/drive/${driveId}/files/${fileId}`, {
      query: { with: "path,etag,capabilities,parents" },
      diagnostics: { operation: "get_file" },
      signal,
    });
    if (!response.data) throw new KDriveApiError("Infomaniak returned no file metadata.");
    return response.data;
  }

  async listDirectory(
    driveId: number,
    directoryId: number,
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<CursorPage<KDriveFile>> {
    const response = await this.jsonRequest<KDriveFile[]>(`/3/drive/${driveId}/files/${directoryId}/files`, {
      query: {
        cursor: options.cursor,
        limit: Math.min(Math.max(options.limit ?? 100, 5), 1000),
        with: "path,etag,capabilities",
      },
      diagnostics: { operation: "list_directory" },
      signal: options.signal,
    });
    return {
      data: response.data ?? [],
      cursor: response.cursor ?? undefined,
      has_more: response.has_more,
      response_at: response.response_at,
    };
  }

  async resolvePath(driveId: number, path: string, signal?: AbortSignal): Promise<KDriveFile> {
    const normalized = normalizeKDrivePath(path);
    if (normalized === "/") return this.getFile(driveId, 1, signal);

    let current: KDriveFile = await this.getFile(driveId, 1, signal);
    for (const segment of normalized.slice(1).split("/")) {
      if (current.type !== "dir") {
        throw new Error(`Cannot resolve ${normalized}: ${current.path ?? current.name} is not a folder.`);
      }

      const exactMatches: KDriveFile[] = [];
      const caseInsensitiveMatches: KDriveFile[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.listDirectory(driveId, current.id, { cursor, limit: 1000, signal });
        exactMatches.push(...page.data.filter((item) => item.name.normalize("NFC") === segment));
        caseInsensitiveMatches.push(...page.data.filter(
          (item) => item.name.normalize("NFC") !== segment
            && item.name.normalize("NFC").toLocaleLowerCase() === segment.toLocaleLowerCase(),
        ));
        cursor = page.has_more ? page.cursor : undefined;
        if (page.has_more && !cursor) throw new Error(`kDrive did not return a cursor while resolving ${normalized}.`);
      } while (cursor && exactMatches.length === 0);

      const matches = exactMatches.length > 0 ? exactMatches : caseInsensitiveMatches;
      if (matches.length === 0) throw new Error(`No kDrive item exists at ${normalized}.`);
      if (matches.length > 1) throw new Error(`The path ${normalized} is ambiguous because multiple items match ${segment}.`);
      current = matches[0]!;
    }
    return current;
  }

  async search(
    driveId: number,
    query: string,
    options: {
      directoryId?: number;
      cursor?: string;
      limit?: number;
      queryScope?: "all" | "content" | "filename";
      types?: string[];
    } = {},
  ): Promise<CursorPage<KDriveFile>> {
    const response = await this.jsonRequest<KDriveFile[]>(`/3/drive/${driveId}/files/search`, {
      query: {
        query,
        query_scope: options.queryScope ?? "all",
        directory_id: options.directoryId,
        depth: "unlimited",
        types: options.types,
        cursor: options.cursor,
        limit: Math.min(Math.max(options.limit ?? 50, 5), 1000),
        with: "path,etag,capabilities",
      },
      diagnostics: { operation: "search" },
    });
    return {
      data: response.data ?? [],
      cursor: response.cursor ?? undefined,
      has_more: response.has_more,
      response_at: response.response_at,
    };
  }

  async download(
    driveId: number,
    fileId: number,
    options: { convertAs?: "text" | "pdf"; maxBytes?: number } = {},
  ): Promise<DownloadResult> {
    const response = await this.rawRequest(`/2/drive/${driveId}/files/${fileId}/download`, {
      query: { as: options.convertAs },
      headers: { accept: "*/*" },
      diagnostics: { operation: "download" },
    });
    return {
      bytes: await readResponseBytes(response, options.maxBytes),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /** History can be empty, and its newest entry is not necessarily current.
   * Bind new exports to the current file ETag; every byte stream is checked again.
   */
  async resolveBinaryVersion(driveId: number, path: string, signal: AbortSignal) {
    const resolved = await this.resolvePath(driveId, path, signal);
    const before = await this.getFile(driveId, resolved.id, signal);
    if (before.type === "dir" || typeof before.etag !== "string" || !before.etag.trim() || before.etag.length > 1024) {
      throw new BinaryTransferError("Binary export requires a file with a valid version ETag.");
    }
    const after = await this.getFile(driveId, before.id, signal);
    if (typeof before.size !== "number" || !Number.isSafeInteger(before.size) || before.size < 0
      || before.etag !== after.etag || before.size !== after.size) {
      throw new BinaryTransferError("Current file metadata changed or has no valid size. Retry after the file stops changing.");
    }
    return { file: before, versionId: before.etag };
  }

  async downloadVersionStream(driveId: number, fileId: number, versionId: number | string, signal: AbortSignal): Promise<Response> {
    // Numeric IDs remain supported for already issued historical-version links.
    if (typeof versionId === "string") {
      const before = await this.getFile(driveId, fileId, signal);
      if (!versionId || before.etag !== versionId || before.type === "dir") {
        throw new BinaryTransferError("The exported file version has changed or is unavailable. Export it again.");
      }
      const upstream = await this.fetchBinaryDownload(`/2/drive/${driveId}/files/${fileId}/download`, signal);
      const reader = upstream.body!.getReader();
      const client = this;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const next = await reader.read();
            if (!next.done) { controller.enqueue(next.value); return; }
            const after = await client.getFile(driveId, fileId, signal);
            if (after.etag !== versionId || after.size !== before.size) {
              throw new BinaryTransferError("The exported file version changed during download.");
            }
            reader.releaseLock(); controller.close();
          } catch (error) { await reader.cancel().catch(() => undefined); controller.error(error); }
        },
        async cancel() { await reader.cancel(); },
      }), { headers: upstream.headers });
    }
    return this.fetchBinaryDownload(`/2/drive/${driveId}/files/${fileId}/versions/${versionId}/download`, signal);
  }

  private async fetchBinaryDownload(path: string, signal: AbortSignal): Promise<Response> {
    const url = this.buildUrl(path);
    const token = await this.tokenProvider.getAccessToken();
    const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: "*/*" }, redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const target = new URL(response.headers.get("location") ?? "", url);
      // CDN bearer URLs are followed without forwarding the API credential.
      if (target.hostname !== "download.kdrive.infomaniakusercontent.com"
        && !target.hostname.endsWith(".download.kdrive.infomaniakusercontent.com")) {
        throw new BinaryTransferError("Unexpected kDrive binary download destination.");
      }
      return fetchBinarySource(target.href, [target.hostname], signal, this.fetchImpl);
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new BinaryTransferError("The pinned kDrive version is unavailable.");
    }
    return response;
  }

  /** Stream into an uncommitted upload session; integrity is checked before finish. */
  async uploadBinary(driveId: number, input: {
    body: ReadableStream<Uint8Array>; size: number; fileName: string; directoryId: number;
    expectedSha256?: string; signal: AbortSignal;
  }): Promise<{ file: KDriveFile; size_bytes: number; sha256: string }> {
    let session: { token: string; upload_url: string } | undefined;
    let finished = false;
    let finalizationStarted = false;
    try {
      const started = await this.jsonRequest<{ token: string; upload_url: string }>(`/3/drive/${driveId}/upload/session/start`, {
        method: "POST", signal: input.signal, redirect: "error", retry401: false,
        json: { directory_id: input.directoryId, file_name: input.fileName, conflict: "error", total_size: input.size, total_chunks: Math.ceil(input.size / BINARY_CHUNK_BYTES) },
      });
      session = started.data;
      if (!session || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.token)) throw new BinaryTransferError("kDrive did not create a valid binary upload session.");
      const uploadUrl = new URL(session.upload_url);
      if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password || uploadUrl.port
        || !["api.infomaniak.com", "api.kdrive.infomaniak.com"].includes(uploadUrl.hostname)) {
        throw new BinaryTransferError("Unexpected kDrive upload destination.");
      }
      const hash = createHash("sha256");
      let chunkNumber = 0;
      let size = 0;
      for await (const chunk of binaryChunks(input.body, input.size, input.signal)) {
        hash.update(chunk);
        size += chunk.byteLength;
        const digest = createHash("sha256").update(chunk).digest("hex");
        chunkNumber++;
        const appended = await this.jsonRequest<{ status: string }>(uploadUrl.href, {
          method: "POST", body: chunk, signal: input.signal, redirect: "error", retry401: false,
          query: { chunk_number: chunkNumber, chunk_size: chunk.byteLength, chunk_hash: `sha256:${digest}` },
        });
        if (appended.data?.status !== "ok") throw new BinaryTransferError("kDrive rejected a binary upload chunk.");
      }
      const digest = hash.digest("hex");
      if (size !== input.size || (input.expectedSha256 && digest !== input.expectedSha256.toLowerCase())) {
        throw new BinaryTransferError("Binary integrity check failed; the upload was not finalized.");
      }
      // Each chunk is independently verified by the provider. Avoid assuming a
      // text-vs-raw encoding for the optional aggregate hash of chunk hashes.
      finalizationStarted = true;
      const result = await this.jsonRequest<{ result: boolean; file: KDriveFile }>(`/3/drive/${driveId}/upload/session/${session.token}/finish`, {
        method: "POST", json: {}, query: { with: "path,etag,version" }, signal: input.signal, redirect: "error", retry401: false,
      });
      if (result.data?.result !== true || !result.data.file) throw new BinaryTransferError("kDrive did not confirm binary upload completion. Check the destination before retrying.");
      finished = true;
      if (result.data.file.size !== size) throw new BinaryTransferError("kDrive returned an unexpected completed file size. Check the destination before retrying.");
      return { file: result.data.file, size_bytes: size, sha256: digest };
    } catch (error) {
      if (error instanceof BinaryTransferError) throw error;
      // Provider errors may echo signed URLs or credentials; never return them.
      throw new BinaryTransferError("Binary upload failed or timed out. Check the destination before retrying if finalization may have started.");
    } finally {
      await input.body.cancel().catch(() => undefined);
      if (session && !finished && !finalizationStarted && /^[a-zA-Z0-9_-]{1,128}$/.test(session.token)) {
        await this.jsonRequest(`/3/drive/${driveId}/upload/session/${session.token}`, {
          method: "DELETE", signal: AbortSignal.timeout(10_000), redirect: "error",
        }).catch(() => undefined); // Provider also automatically expires unfinished sessions.
      }
    }
  }

  async downloadText(
    driveId: number,
    fileId: number,
    options: { file?: KDriveFile; maxBytes?: number } = {},
  ): Promise<TextDownloadResult> {
    const file = options.file ?? await this.getFile(driveId, fileId);
    if (isTextContentType(file.mime_type)) {
      return { ...await this.download(driveId, fileId, { maxBytes: options.maxBytes }), textSource: "raw" };
    }

    try {
      const response = await this.rawRequest(`/2/drive/${driveId}/files/${fileId}/preview`, {
        query: { as: "text" },
        headers: { accept: "*/*" },
        diagnostics: { operation: "preview" },
      });
      return {
        bytes: await readResponseBytes(response, options.maxBytes),
        contentType: response.headers.get("content-type") ?? "text/plain",
        textSource: "converted",
      };
    } catch (previewError) {
      if (previewError instanceof ResponseBodyLimitError) throw previewError;
      try {
        return {
          ...await this.download(driveId, fileId, { convertAs: "text", maxBytes: options.maxBytes }),
          textSource: "converted",
        };
      } catch (conversionError) {
        if (conversionError instanceof ResponseBodyLimitError) throw conversionError;
        const raw = await this.download(driveId, fileId, { maxBytes: options.maxBytes });
        if (!isTextContentType(raw.contentType)) throw previewError;
        return { ...raw, textSource: "raw" };
      }
    }
  }

  async createDirectory(
    driveId: number,
    parentId: number,
    name: string,
    color?: string,
    diagnostics?: { traceId: string },
  ): Promise<KDriveFile> {
    const response = await this.jsonRequest<KDriveFile>(`/3/drive/${driveId}/files/${parentId}/directory`, {
      method: "POST",
      json: { name, ...(color ? { color } : {}) },
      query: { with: "path,capabilities" },
      diagnostics: { operation: "create_directory", traceId: diagnostics?.traceId },
    });
    if (!response.data) throw new KDriveApiError("Infomaniak did not return the new directory.");
    return response.data;
  }

  async upload(
    driveId: number,
    input: {
      bytes: Uint8Array;
      fileName?: string;
      directoryId?: number;
      fileId?: number;
      conflict?: "error" | "rename" | "version";
      etag?: string;
    },
  ): Promise<KDriveFile> {
    const response = await this.jsonRequest<KDriveFile>(`/3/drive/${driveId}/upload`, {
      method: "POST",
      body: input.bytes,
      headers: input.etag ? { "if-match": input.etag } : undefined,
      query: {
        total_size: input.bytes.byteLength,
        client_token: randomUUID(),
        file_name: input.fileName,
        directory_id: input.directoryId,
        file_id: input.fileId,
        conflict: input.conflict,
        with: "path,etag,capabilities",
      },
      diagnostics: { operation: "upload" },
    });
    if (!response.data) throw new KDriveApiError("Infomaniak did not return the uploaded file.");
    return response.data;
  }

  async rename(driveId: number, fileId: number, name: string): Promise<KDriveFile | boolean> {
    const response = await this.jsonRequest<KDriveFile | boolean>(`/2/drive/${driveId}/files/${fileId}/rename`, {
      method: "POST",
      json: { name },
      diagnostics: { operation: "rename" },
    });
    return response.data ?? true;
  }

  async move(
    driveId: number,
    fileId: number,
    destinationDirectoryId: number,
    diagnostics?: { traceId: string },
  ): Promise<KDriveFile | boolean> {
    const response = await this.jsonRequest<KDriveFile | boolean>(
      `/3/drive/${driveId}/files/${fileId}/move/${destinationDirectoryId}`,
      {
        method: "POST",
        json: { conflict: "error" },
        diagnostics: { operation: "move", traceId: diagnostics?.traceId },
      },
    );
    return response.data ?? true;
  }

  async trash(driveId: number, fileId: number, diagnostics?: { traceId: string }): Promise<boolean> {
    const response = await this.jsonRequest<boolean>(`/2/drive/${driveId}/files/${fileId}`, {
      method: "DELETE",
      diagnostics: { operation: "trash", traceId: diagnostics?.traceId },
    });
    return response.data ?? true;
  }

  async restore(
    driveId: number,
    fileId: number,
    destinationDirectoryId: number,
    diagnostics?: { traceId: string },
  ): Promise<KDriveFile | boolean> {
    const response = await this.jsonRequest<KDriveFile | boolean>(`/2/drive/${driveId}/trash/${fileId}/restore`, {
      method: "POST",
      json: { destination_directory_id: destinationDirectoryId },
      diagnostics: { operation: "restore", traceId: diagnostics?.traceId },
    });
    return response.data ?? true;
  }
}
