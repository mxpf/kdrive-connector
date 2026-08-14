import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { KDriveApiError } from "./errors.js";
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
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  json?: unknown;
  body?: Uint8Array;
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
  const segments = trimmed.split("/").filter(Boolean);
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
      });
    };

    let response = await makeRequest(false);
    if (response.status === 401) response = await makeRequest(true);
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as ApiEnvelope<unknown> | undefined;
      const message = payload?.error?.description ?? `Infomaniak API request failed with HTTP ${response.status}.`;
      throw new KDriveApiError(message, response.status, payload?.error?.code, payload?.error);
    }
    return response;
  }

  private async jsonRequest<T>(endpoint: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
    const response = await this.rawRequest(endpoint, options);
    const payload = (await response.json()) as ApiEnvelope<T>;
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
    });
    return response.data ?? {};
  }

  async getFile(driveId: number, fileId: number): Promise<KDriveFile> {
    const response = await this.jsonRequest<KDriveFile>(`/3/drive/${driveId}/files/${fileId}`, {
      query: { with: "path,etag,capabilities,parents" },
    });
    if (!response.data) throw new KDriveApiError("Infomaniak returned no file metadata.");
    return response.data;
  }

  async listDirectory(
    driveId: number,
    directoryId: number,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<CursorPage<KDriveFile>> {
    const response = await this.jsonRequest<KDriveFile[]>(`/3/drive/${driveId}/files/${directoryId}/files`, {
      query: {
        cursor: options.cursor,
        limit: Math.min(Math.max(options.limit ?? 100, 5), 1000),
        with: "path,etag,capabilities",
      },
    });
    return {
      data: response.data ?? [],
      cursor: response.cursor ?? undefined,
      has_more: response.has_more,
      response_at: response.response_at,
    };
  }

  async resolvePath(driveId: number, path: string): Promise<KDriveFile> {
    const normalized = normalizeKDrivePath(path);
    if (normalized === "/") return this.getFile(driveId, 1);

    let current: KDriveFile = await this.getFile(driveId, 1);
    for (const segment of normalized.slice(1).split("/")) {
      if (current.type !== "dir") {
        throw new Error(`Cannot resolve ${normalized}: ${current.path ?? current.name} is not a folder.`);
      }

      const exactMatches: KDriveFile[] = [];
      const caseInsensitiveMatches: KDriveFile[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.listDirectory(driveId, current.id, { cursor, limit: 1000 });
        exactMatches.push(...page.data.filter((item) => item.name === segment));
        caseInsensitiveMatches.push(...page.data.filter(
          (item) => item.name !== segment && item.name.toLocaleLowerCase() === segment.toLocaleLowerCase(),
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
    options: { convertAs?: "text" | "pdf" } = {},
  ): Promise<DownloadResult> {
    const response = await this.rawRequest(`/2/drive/${driveId}/files/${fileId}/download`, {
      query: { as: options.convertAs },
      headers: { accept: "*/*" },
    });
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async downloadText(driveId: number, fileId: number): Promise<TextDownloadResult> {
    const file = await this.getFile(driveId, fileId);
    if (isTextContentType(file.mime_type)) {
      return { ...await this.download(driveId, fileId), textSource: "raw" };
    }

    try {
      const response = await this.rawRequest(`/2/drive/${driveId}/files/${fileId}/preview`, {
        query: { as: "text" },
        headers: { accept: "*/*" },
      });
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? "text/plain",
        textSource: "converted",
      };
    } catch (previewError) {
      try {
        return { ...await this.download(driveId, fileId, { convertAs: "text" }), textSource: "converted" };
      } catch {
        const raw = await this.download(driveId, fileId);
        if (!isTextContentType(raw.contentType)) throw previewError;
        return { ...raw, textSource: "raw" };
      }
    }
  }

  async createDirectory(driveId: number, parentId: number, name: string, color?: string): Promise<KDriveFile> {
    const response = await this.jsonRequest<KDriveFile>(`/3/drive/${driveId}/files/${parentId}/directory`, {
      method: "POST",
      json: { name, ...(color ? { color } : {}) },
      query: { with: "path,capabilities" },
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
    });
    if (!response.data) throw new KDriveApiError("Infomaniak did not return the uploaded file.");
    return response.data;
  }

  async rename(driveId: number, fileId: number, name: string): Promise<KDriveFile | boolean> {
    const response = await this.jsonRequest<KDriveFile | boolean>(`/2/drive/${driveId}/files/${fileId}/rename`, {
      method: "POST",
      json: { name },
    });
    return response.data ?? true;
  }

  async move(driveId: number, fileId: number, destinationDirectoryId: number): Promise<KDriveFile | boolean> {
    const response = await this.jsonRequest<KDriveFile | boolean>(
      `/3/drive/${driveId}/files/${fileId}/move/${destinationDirectoryId}`,
      { method: "POST", json: { conflict: "error" } },
    );
    return response.data ?? true;
  }

  async trash(driveId: number, fileId: number): Promise<boolean> {
    const response = await this.jsonRequest<boolean>(`/2/drive/${driveId}/files/${fileId}`, { method: "DELETE" });
    return response.data ?? true;
  }

  async restore(driveId: number, fileId: number): Promise<KDriveFile | boolean> {
    const response = await this.jsonRequest<KDriveFile | boolean>(`/2/drive/${driveId}/trash/${fileId}/restore`, {
      method: "POST",
      json: {},
    });
    return response.data ?? true;
  }
}
