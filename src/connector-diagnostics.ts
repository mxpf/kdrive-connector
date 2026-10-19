import { BINARY_MAX_BYTES, BINARY_TIMEOUT_MS, EXPORT_TTL_MS } from "./binary-transport.js";
import { DIGEST_CACHE_MAX_ENTRIES, DIGEST_CACHE_TTL_MS } from "./binary-digest-cache.js";
import { PDF_LIMITS } from "./pdf-extract.js";
import { DEFAULT_BINARY_SOURCE_HOSTS } from "./binary-source-hosts.js";
import { PDF_JOB_LIMITS } from "./pdf-jobs.js";

export const CONNECTOR_VERSION = "0.3.1";
export const CAPABILITY_REVISION = "2026-10-19.2";

// A deployment ID identifies the actual running Worker, not the client's catalog.
// Local builds deliberately report unknown rather than inventing a Git revision.
export function connectorDiagnostics(options: {
  buildId?: string; binaryExport: boolean; maxReadBytes: number; pdfOcr?: boolean; pdfOcrJobs?: boolean;
  maxUploadBytes: number; maxBinaryBytes?: number;
  binarySourceHosts?: readonly string[];
  digestCacheScope?: "authenticated_registration" | "authenticated_owner_drive";
}) {
  return {
    version: CONNECTOR_VERSION,
    build_id: options.buildId ?? "unknown-local-build",
    capability_revision: CAPABILITY_REVISION,
    capabilities: { binary_export: options.binaryExport, native_file_upload: true, https_upload: true, range_download: false, pdf_text_extraction: true, pdf_form_values: true, pdf_ocr: options.pdfOcr ?? false, pdf_ocr_jobs: Boolean(options.pdfOcr && options.pdfOcrJobs) },
    binary_source_policy: { revision: "2026-10-19.1", matching: "exact_https_hosts", redirects_revalidated: true,
      trusted_hosts: [...(options.binarySourceHosts ?? DEFAULT_BINARY_SOURCE_HOSTS)], authoritative_error_field: "binary_error_code" },
    optimizations: { binary_digest_cache: { enabled: options.binaryExport, max_entries: DIGEST_CACHE_MAX_ENTRIES, ttl_ms: DIGEST_CACHE_TTL_MS, scope: options.digestCacheScope ?? "authenticated_registration" } },
    limits: {
      inline_read_bytes: options.maxReadBytes, inline_upload_bytes: options.maxUploadBytes,
      binary_bytes: options.maxBinaryBytes ?? BINARY_MAX_BYTES,
      binary_timeout_ms: BINARY_TIMEOUT_MS, export_ttl_ms: EXPORT_TTL_MS,
      pdf: PDF_LIMITS,
      ...(options.pdfOcr && options.pdfOcrJobs ? { pdf_ocr_job: PDF_JOB_LIMITS } : {}),
    },
  };
}
