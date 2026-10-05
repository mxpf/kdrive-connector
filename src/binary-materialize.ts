import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BINARY_MAX_BYTES, BINARY_TIMEOUT_MS, type BinaryExportReference } from "./binary-transport.js";
import { BinaryDownloadError, downloadResponseError } from "./download-diagnostics.js";

/** Local host bridge: never returns a path until all bytes and the digest verify. */
export async function materializeBinaryReference(ref: BinaryExportReference, options: {
  origin: string; directory?: string; signal?: AbortSignal; fetcher?: typeof fetch;
}) {
  let url: URL;
  try { url = new URL(ref.download_url); } catch { throw new Error("Invalid binary reference."); }
  if (url.protocol !== "https:" || url.origin !== new URL(options.origin).origin || url.username || url.password
    || !url.pathname.startsWith("/binary/") || url.search || url.hash
    || !Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0 || ref.size_bytes > BINARY_MAX_BYTES
    || !/^[a-f0-9]{64}$/i.test(ref.sha256) || !ref.resolved_version
    || !ref.file_name || ref.file_name === "." || ref.file_name === ".." || /[/\\\x00-\x1f]/.test(ref.file_name)) {
    throw new Error("Invalid binary reference.");
  }
  if (!Number.isFinite(Date.parse(ref.expires_at)) || Date.parse(ref.expires_at) <= Date.now()) throw new BinaryDownloadError("REFERENCE_INVALID_OR_EXPIRED");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(BINARY_TIMEOUT_MS)]) : AbortSignal.timeout(BINARY_TIMEOUT_MS);
  const directory = await mkdtemp(join(options.directory ?? tmpdir(), "kdrive-download-"));
  const partial = join(directory, ".partial");
  const target = join(directory, ref.file_name);
  let traceId: string | null = null;
  try {
    const response = await (options.fetcher ?? fetch)(url, { redirect: "error", signal, headers: { "accept-encoding": "identity" } });
    traceId = response.headers.get("x-kdrive-trace-id");
    if (response.status !== 200) {
      const error = downloadResponseError(response);
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (response.status !== 200 || !response.body || (response.headers.get("content-encoding") ?? "identity") !== "identity") {
      await response.body?.cancel(); throw new Error("Invalid response");
    }
    const length = response.headers.get("content-length");
    if (length !== null && length !== String(ref.size_bytes)) { await response.body.cancel(); throw new Error("Size mismatch"); }
    let bytes = 0;
    const hash = createHash("sha256");
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > ref.size_bytes) { callback(new Error("Size exceeded")); return; }
        hash.update(chunk); callback(null, chunk);
      },
    }), createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal });
    const sha256 = hash.digest("hex");
    if (bytes !== ref.size_bytes || sha256 !== ref.sha256.toLowerCase()) throw new Error("Integrity mismatch");
    await rename(partial, target);
    return { local_path: target, file_name: ref.file_name, mime_type: ref.mime_type, size_bytes: bytes, sha256, resolved_version: ref.resolved_version };
  } catch (error) {
    // This directory was created exclusively by this invocation; never remove caller paths.
    await rm(directory, { recursive: true, force: true });
    if (error instanceof BinaryDownloadError) throw error;
    throw new BinaryDownloadError("DOWNLOAD_FAILED", traceId);
  }
}
