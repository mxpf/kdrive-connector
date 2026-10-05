const messages = {
  REFERENCE_INVALID_OR_EXPIRED: "Binary reference expired or unavailable; call kdrive_export_file again and verify the returned version before retrying.",
  VERSION_CHANGED: "The pinned file version is unavailable; export again and compare resolved_version.",
  UPSTREAM_AUTHENTICATION_FAILED: "The connector's upstream authentication failed; check connector health.",
  UPSTREAM_ACCESS_DENIED: "The upstream service denied access to the file.",
  UPSTREAM_RATE_LIMITED: "The upstream service is rate limiting requests; retry later while the reference remains valid.",
  UPSTREAM_UNAVAILABLE: "The upstream download service is unavailable; retry later while the reference remains valid.",
  TRANSFER_TIMEOUT: "The binary download timed out; retry while the reference remains valid.",
  DOWNLOAD_FAILED: "Binary download failed, was interrupted, or did not match its size/SHA-256; no completed local file was published.",
} as const;
type Code = keyof typeof messages;

export class BinaryDownloadError extends Error {
  readonly code: Code;
  readonly traceId?: string;
  constructor(code: string, traceId?: string | null) {
    const safeCode: Code = Object.hasOwn(messages, code) ? code as Code : "DOWNLOAD_FAILED";
    const safeTrace = traceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(traceId) ? traceId : undefined;
    super(`${safeCode}: ${messages[safeCode]}${safeTrace ? ` Trace: ${safeTrace}` : ""}`);
    this.code = safeCode;
    this.traceId = safeTrace;
  }
}

export function downloadResponseError(response: Response): BinaryDownloadError {
  const fallback = ({ 409: "VERSION_CHANGED", 410: "REFERENCE_INVALID_OR_EXPIRED", 429: "UPSTREAM_RATE_LIMITED", 502: "UPSTREAM_UNAVAILABLE", 504: "TRANSFER_TIMEOUT" } as Record<number, string>)[response.status] ?? "DOWNLOAD_FAILED";
  const code = response.headers.get("x-kdrive-error-code");
  return new BinaryDownloadError(code && Object.hasOwn(messages, code) ? code : fallback, response.headers.get("x-kdrive-trace-id"));
}
