import { BINARY_MAX_BYTES, BINARY_TIMEOUT_MS, EXPORT_TTL_MS } from "./binary-transport.js";
import { DIGEST_CACHE_MAX_ENTRIES, DIGEST_CACHE_TTL_MS } from "./binary-digest-cache.js";

export const CONNECTOR_VERSION = "0.3.1";
export const CAPABILITY_REVISION = "2026-10-05.3";

// A deployment ID identifies the actual running Worker, not the client's catalog.
// Local builds deliberately report unknown rather than inventing a Git revision.
export function connectorDiagnostics(options: {
  buildId?: string; binaryExport: boolean; maxReadBytes: number;
  maxUploadBytes: number; maxBinaryBytes?: number;
  digestCacheScope?: "authenticated_registration" | "authenticated_owner_drive";
}) {
  return {
    version: CONNECTOR_VERSION,
    build_id: options.buildId ?? "unknown-local-build",
    capability_revision: CAPABILITY_REVISION,
    capabilities: { binary_export: options.binaryExport, native_file_upload: true, https_upload: true, range_download: false },
    optimizations: { binary_digest_cache: { enabled: options.binaryExport, max_entries: DIGEST_CACHE_MAX_ENTRIES, ttl_ms: DIGEST_CACHE_TTL_MS, scope: options.digestCacheScope ?? "authenticated_registration" } },
    limits: {
      inline_read_bytes: options.maxReadBytes, inline_upload_bytes: options.maxUploadBytes,
      binary_bytes: options.maxBinaryBytes ?? BINARY_MAX_BYTES,
      binary_timeout_ms: BINARY_TIMEOUT_MS, export_ttl_ms: EXPORT_TTL_MS,
    },
  };
}
