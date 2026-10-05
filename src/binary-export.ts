import { createHash } from "node:crypto";
import { BINARY_MAX_BYTES, BINARY_TIMEOUT_MS, EXPORT_TTL_MS, BinaryTransferError, type BinaryExportReference } from "./binary-transport.js";
import { binaryErrorCode, binaryTrace } from "./binary-diagnostics.js";
import type { KDriveClient, KDriveFile } from "./kdrive-client.js";
import { assertExportPayload, signKDrivePayload, verifyKDrivePayload } from "./operation-token.js";

export async function createBinaryExport(secret: string, origin: string, subject: string, driveId: number,
  file: KDriveFile, versionId: number | string, digest: { size_bytes: number; sha256: string; trace_id?: string }, now = Date.now()): Promise<BinaryExportReference> {
  const base = new URL(origin);
  if (base.protocol !== "https:") throw new Error("Binary exports require HTTPS.");
  const expiresAt = now + EXPORT_TTL_MS;
  const mime = file.mime_type && /^[\w.+-]+\/[\w.+-]+$/.test(file.mime_type) ? file.mime_type : "application/octet-stream";
  const token = await signKDrivePayload(secret, {
    v: 1, type: "export", driveId, fileId: file.id, versionId, subject: subject.toLowerCase(),
    fileName: file.name, mimeType: mime, size: digest.size_bytes, sha256: digest.sha256,
    issuedAt: now, expiresAt,
    ...(digest.trace_id ? { traceId: digest.trace_id } : {}),
  });
  return { file_name: file.name, mime_type: mime, ...digest,
    download_url: `${base.origin}/binary/${token}`, expires_at: new Date(expiresAt).toISOString(),
    resolved_version: String(versionId),
  };
}

export async function serveBinaryExport(request: Request, token: string, config: {
  secret: string; subject: string; driveId: number; client: Pick<KDriveClient, "downloadVersionStream">; maxBytes?: number;
}): Promise<Response> {
  const headers = new Headers({ "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" });
  let trace = binaryTrace("binary_download");
  let validReference = false;
  try {
    const payload = await verifyKDrivePayload(config.secret, token);
    assertExportPayload(payload);
    if (payload.expiresAt <= Date.now() || payload.driveId !== config.driveId || payload.subject !== config.subject.toLowerCase()
      || payload.size > (config.maxBytes ?? BINARY_MAX_BYTES)) throw new Error("Invalid export");
    validReference = true;
    trace = binaryTrace("binary_download", payload.traceId);
    headers.set("x-kdrive-trace-id", trace.traceId);
    if (!["GET", "HEAD"].includes(request.method)) { trace.complete(false, "METHOD_NOT_ALLOWED"); return new Response(null, { status: 405, headers }); }
    headers.set("content-type", payload.mimeType);
    headers.set("content-disposition", `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(payload.fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`);
    headers.set("content-length", String(payload.size));
    headers.set("etag", `"sha256-${payload.sha256}"`);
    headers.set("accept-ranges", "none");
    if (request.method === "HEAD") { trace.complete(true); return new Response(null, { headers }); }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), BINARY_TIMEOUT_MS);
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) controller.abort();
    const cleanup = () => { clearTimeout(deadline); request.signal.removeEventListener("abort", abort); };
    let upstream: Response;
    trace.progress("download");
    try { upstream = await config.client.downloadVersionStream(payload.driveId, payload.fileId, payload.versionId, controller.signal); }
    catch (error) { cleanup(); throw error; }
    if (!upstream.body) { cleanup(); throw new Error("Missing binary body"); }
    const reader = upstream.body.getReader();
    let size = 0;
    let pending: Uint8Array | undefined;
    const hash = createHash("sha256");
    const body = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          while (true) {
          controller.signal.throwIfAborted();
          const { done, value } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) {
            if (size !== payload.size || hash.digest("hex") !== payload.sha256) throw new BinaryTransferError("Binary integrity failure", "INTEGRITY_MISMATCH");
            if (pending) output.enqueue(pending);
            trace.progress("download", size); trace.complete(true);
            cleanup(); reader.releaseLock(); output.close(); return;
          }
          size += value.byteLength;
          if (size > payload.size) throw new BinaryTransferError("Binary size exceeded", "INTEGRITY_MISMATCH");
          hash.update(value);
          // Withhold the final chunk until the digest is verified, so a consumer
          // cannot receive Content-Length bytes before discovering corruption.
          const previous = pending;
          pending = value;
          if (previous) { output.enqueue(previous); return; }
          }
        } catch (error) {
          trace.progress("download", size);
          trace.complete(false, binaryErrorCode(error));
          cleanup(); controller.abort(); await reader.cancel().catch(() => undefined);
          output.error(new Error("Pinned binary download failed integrity or deadline validation."));
        }
      },
      async cancel() { trace.progress("download", size); trace.complete(false, "DOWNLOAD_CANCELLED"); cleanup(); controller.abort(); await reader.cancel().catch(() => undefined); },
    });
    return new Response(body, { headers });
  } catch (error) {
    const code = !validReference ? "REFERENCE_INVALID_OR_EXPIRED" : binaryErrorCode(error);
    // Upstream auth errors are not a challenge to reauthenticate this bearer link.
    const status = !validReference ? 410 : code === "VERSION_CHANGED" ? 409 : code === "TRANSFER_TIMEOUT" ? 504 : code === "UPSTREAM_RATE_LIMITED" ? 429 : 502;
    trace.complete(false, code);
    headers.set("x-kdrive-trace-id", trace.traceId);
    headers.set("x-kdrive-error-code", code);
    headers.delete("content-length");
    headers.delete("content-disposition");
    headers.delete("etag");
    headers.set("content-type", "text/plain; charset=utf-8");
    const message = status === 410 || status === 409
      ? "This binary reference is invalid, expired, or its pinned version is unavailable. Call kdrive_export_file for a fresh reference and compare resolved_version before continuing."
      : "The upstream binary download failed or timed out. This does not establish that the reference expired. Retry while valid, or request a fresh reference and compare resolved_version.";
    return new Response(`${code}: ${message} Trace: ${trace.traceId}`, { status, headers });
  }
}
