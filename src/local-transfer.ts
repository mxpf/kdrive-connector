import { constants, createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { KDriveClient, normalizeKDrivePath, splitKDrivePath } from "./kdrive-client.js";
import { classifyBinaryFailure, hashBinary } from "./binary-transport.js";

// Local-only limits: never change the remote Worker's ceiling or CPU budget.
export const LOCAL_MAX_BYTES = 1024 * 1024 * 1024;
export const LOCAL_TIMEOUT_MS = 30 * 60 * 1000;
export type TransferClient = Pick<KDriveClient, "resolvePath" | "resolveBinaryVersion" | "downloadVersionStream" | "uploadBinary">;
export interface LocalTransferOptions {
  signal: AbortSignal;
  expectedSize?: number;
  expectedSha256?: string;
  temporaryRoot?: string;
  onProgress?: (progress: { stage: string; bytes: number; total: number }) => void;
  onSnapshot?: (snapshot: { size_bytes: number; sha256: string }) => Promise<void>;
  onCommitted?: (receipt: Record<string, unknown>) => Promise<void>;
}

export class LocalTransferError extends Error {
  constructor(readonly code: string, readonly receipt?: Record<string, unknown>) {
    super(code); this.name = "LocalTransferError";
  }
}

export function validateExpectations(options: LocalTransferOptions) {
  if (options.expectedSize !== undefined && (!Number.isSafeInteger(options.expectedSize) || options.expectedSize < 1 || options.expectedSize > LOCAL_MAX_BYTES)) {
    throw new LocalTransferError("INVALID_EXPECTED_SIZE");
  }
  if (options.expectedSha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(options.expectedSha256)) {
    throw new LocalTransferError("INVALID_EXPECTED_SHA256");
  }
  options.signal.throwIfAborted();
}

function checkSize(size: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > LOCAL_MAX_BYTES) throw new LocalTransferError("SIZE_LIMIT_EXCEEDED");
}

function checkIntegrity(size: number, sha256: string, options: LocalTransferOptions) {
  if ((options.expectedSize !== undefined && size !== options.expectedSize)
    || (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256.toLowerCase())) {
    throw new LocalTransferError("INTEGRITY_MISMATCH");
  }
}

export function remotePath(value: string) {
  if (!value.startsWith("/") || /[\x00-\x1f\x7f]/.test(value)) throw new LocalTransferError("INVALID_REMOTE_PATH");
  return normalizeKDrivePath(value);
}

/** Private immutable source snapshot: never upload a file that changes beneath us. */
async function snapshot(source: string, directory: string, options: LocalTransferOptions) {
  if (!path.isAbsolute(source)) throw new LocalTransferError("ABSOLUTE_LOCAL_PATH_REQUIRED");
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new LocalTransferError("REGULAR_FILE_REQUIRED");
    checkSize(Number(before.size));
    options.onProgress?.({ stage: "preparing", bytes: 0, total: Number(before.size) });
    const sha = createHash("sha256");
    let size = 0;
    const filename = path.join(directory, "snapshot");
    await pipeline(handle.createReadStream({ autoClose: false }), async function* (input) {
      for await (const chunk of input) {
        size += chunk.length;
        if (size > Number(before.size)) throw new LocalTransferError("SOURCE_CHANGED");
        sha.update(chunk); options.onProgress?.({ stage: "preparing", bytes: size, total: Number(before.size) }); yield chunk;
      }
    }, createWriteStream(filename, { flags: "wx", mode: 0o600 }), { signal: options.signal });
    const after = await handle.stat({ bigint: true });
    if (size !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new LocalTransferError("SOURCE_CHANGED");
    }
    const sha256 = sha.digest("hex");
    checkIntegrity(size, sha256, options);
    return { filename, size, sha256 };
  } finally { await handle.close(); }
}

/** Check a source against a manifest without contacting kDrive. */
export async function inspectLocalSource(source: string, options: LocalTransferOptions) {
  validateExpectations(options);
  const directory = await mkdtemp(path.join(options.temporaryRoot ?? os.tmpdir(), "kdrive-preview-"));
  try { const copy = await snapshot(source, directory, options); return { size_bytes: copy.size, sha256: copy.sha256 }; }
  finally { await rm(directory, { recursive: true, force: true }); }
}

/** Independent direct-provider readback; no Worker export, cache, or inline digest. */
export async function verifyLocalTransfer(client: TransferClient, driveId: number, destination: string,
  options: LocalTransferOptions, expectedFileId?: number) {
  validateExpectations(options);
  const normalized = remotePath(destination);
  const pinned = await client.resolveBinaryVersion(driveId, normalized, options.signal);
  checkSize(pinned.file.size!);
  if (expectedFileId !== undefined && pinned.file.id !== expectedFileId) throw new LocalTransferError("DESTINATION_CHANGED");
  const response = await client.downloadVersionStream(driveId, pinned.file.id, pinned.versionId, options.signal);
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new LocalTransferError("DOWNLOAD_FAILED"); }
  options.onProgress?.({ stage: "verifying", bytes: 0, total: pinned.file.size! });
  const digest = await hashBinary(response.body, pinned.file.size!, options.signal,
    bytes => options.onProgress?.({ stage: "verifying", bytes, total: pinned.file.size! }));
  checkIntegrity(digest.size_bytes, digest.sha256, { ...options, expectedSize: pinned.file.size! });
  checkIntegrity(digest.size_bytes, digest.sha256, options);
  return { verified: true, path: normalized, file_id: pinned.file.id, file_name: pinned.file.name,
    mime_type: pinned.file.mime_type ?? "application/octet-stream", size_bytes: digest.size_bytes,
    sha256: digest.sha256, version_id: pinned.versionId };
}

export async function uploadLocalFile(client: TransferClient, driveId: number, source: string, destination: string, options: LocalTransferOptions) {
  validateExpectations(options);
  const normalized = remotePath(destination);
  const { parentPath, name } = splitKDrivePath(normalized);
  const directory = await mkdtemp(path.join(options.temporaryRoot ?? os.tmpdir(), "kdrive-upload-"));
  try {
    const copy = await snapshot(source, directory, options);
    await options.onSnapshot?.({ size_bytes: copy.size, sha256: copy.sha256 });
    const parent = await client.resolvePath(driveId, parentPath, options.signal);
    if (parent.type !== "dir") throw new LocalTransferError("DESTINATION_NOT_DIRECTORY");
    // The provider atomically enforces conflict:error; no check-then-overwrite race.
    const result = await client.uploadBinary(driveId, {
      directoryId: parent.id, fileName: name, size: copy.size, expectedSha256: copy.sha256,
      onProgress: (stage, bytes = 0) => options.onProgress?.({ stage: stage === "finalization" ? "finalizing" : "uploading", bytes, total: copy.size }),
      body: Readable.toWeb(createReadStream(copy.filename)) as ReadableStream<Uint8Array>, signal: options.signal,
    });
    const receipt = { uploaded: true, verified: false, path: normalized, file_id: result.file.id,
      size_bytes: copy.size, sha256: copy.sha256 };
    try {
      await options.onCommitted?.(receipt);
      if (!Number.isSafeInteger(result.file.id) || result.file.id <= 0 || result.file.name !== name) {
        throw new LocalTransferError("DESTINATION_METADATA_INVALID");
      }
      return { uploaded: true, ...await verifyLocalTransfer(client, driveId, normalized,
        { ...options, expectedSize: copy.size, expectedSha256: copy.sha256 }, result.file.id) };
    } catch (error) {
      // Keep the uploaded file. Never retry an upload or delete a destination on verification failure.
      throw new LocalTransferError("UPLOADED_NOT_VERIFIED", { ...receipt,
        verification_error: error instanceof LocalTransferError ? error.code : classifyBinaryFailure(error) });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Return a private, verified local file for a downstream tool; caller owns cleanup. */
export async function downloadLocalFile(client: TransferClient, driveId: number, source: string, options: LocalTransferOptions) {
  validateExpectations(options);
  const normalized = remotePath(source);
  const pinned = await client.resolveBinaryVersion(driveId, normalized, options.signal);
  checkSize(pinned.file.size!);
  const directory = await mkdtemp(path.join(options.temporaryRoot ?? os.tmpdir(), "kdrive-download-"));
  try {
    const response = await client.downloadVersionStream(driveId, pinned.file.id, pinned.versionId, options.signal);
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new LocalTransferError("DOWNLOAD_FAILED"); }
    options.onProgress?.({ stage: "downloading", bytes: 0, total: pinned.file.size! });
    const partial = path.join(directory, ".partial");
    const sha = createHash("sha256");
    let size = 0;
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), async function* (input) {
      for await (const chunk of input) {
        size += chunk.length;
        if (size > pinned.file.size!) throw new LocalTransferError("INTEGRITY_MISMATCH");
        sha.update(chunk); options.onProgress?.({ stage: "downloading", bytes: size, total: pinned.file.size! }); yield chunk;
      }
    }, createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal: options.signal });
    const sha256 = sha.digest("hex");
    checkIntegrity(size, sha256, { expectedSize: pinned.file.size!, signal: options.signal });
    checkIntegrity(size, sha256, options);
    // Provider filenames are untrusted: retain the original in metadata, sanitize local basename.
    const name = path.basename(pinned.file.name).replace(/[\\\x00-\x1f\x7f]/g, "_");
    const output = path.join(directory, name && name !== "." && name !== ".." && name !== ".partial" ? name : "download.bin");
    await rename(partial, output);
    return { verified: true, path: normalized, local_path: output, file_id: pinned.file.id,
      file_name: pinned.file.name, mime_type: pinned.file.mime_type ?? "application/octet-stream",
      size_bytes: size, sha256, version_id: pinned.versionId,
      checksum_matched: options.expectedSha256 !== undefined };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
