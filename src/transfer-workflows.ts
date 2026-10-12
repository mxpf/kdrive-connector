import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { classifyBinaryFailure } from "./binary-transport.js";
import { LocalTransferError, inspectLocalSource, remotePath, uploadLocalFile, verifyLocalTransfer, validateExpectations, type TransferClient, type LocalTransferOptions } from "./local-transfer.js";
import { newReceipt, readReceipt, saveReceipt, type TransferReceipt } from "./transfer-journal.js";

export function transferErrorCode(error: unknown): string {
  if (error instanceof LocalTransferError) return error.code;
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (typeof code === "string" && ["ENOENT", "EACCES", "EPERM", "ENOSPC", "ELOOP", "EISDIR", "EMFILE"].includes(code)) return `LOCAL_FILESYSTEM_${code}`;
  return classifyBinaryFailure(error);
}

export async function uploadWithReceipt(client: TransferClient, driveId: number, source: string, destination: string,
  options: LocalTransferOptions, directory?: string) {
  const journal = await newReceipt(driveId, destination, directory);
  const update = async (fields: Partial<TransferReceipt>) => {
    Object.assign(journal.receipt, fields, { updated_at: new Date().toISOString() });
    await saveReceipt(journal.filename, journal.receipt);
  };
  try {
    const result = await uploadLocalFile(client, driveId, source, destination, { ...options,
      onSnapshot: async copy => { await update({ ...copy, state: "uploading" }); },
      onCommitted: async receipt => { await update({ state: "committed", file_id: receipt.file_id as number }); },
    });
    await update({ state: "verified", file_id: result.file_id });
    return { ...result, receipt_path: journal.filename };
  } catch (error) {
    const code = ["committed", "verified"].includes(journal.receipt.state) ? "UPLOADED_NOT_VERIFIED" : transferErrorCode(error);
    const state = code === "UPLOADED_NOT_VERIFIED" ? "unverified" : code === "UPLOAD_COMMIT_UNKNOWN" ? "unknown"
      : ["committed", "verified"].includes(journal.receipt.state) ? "unverified" : "failed";
    // If disk persistence itself fails, retain the last conservative on-disk state.
    await update({ state, error: code }).catch(() => undefined);
    throw new LocalTransferError(code, { ...(error instanceof LocalTransferError ? error.receipt : {}), receipt_path: journal.filename });
  }
}

export async function verifyReceipt(client: TransferClient, driveId: number, filename: string, options: LocalTransferOptions) {
  const receipt = await readReceipt(filename);
  if (receipt.drive_id !== driveId) throw new LocalTransferError("RECEIPT_DRIVE_MISMATCH");
  if (receipt.size_bytes === undefined || !receipt.sha256) throw new LocalTransferError("RECEIPT_NOT_READY");
  const result = await verifyLocalTransfer(client, driveId, receipt.path,
    { ...options, expectedSize: receipt.size_bytes, expectedSha256: receipt.sha256 }, receipt.file_id);
  await saveReceipt(filename, { ...receipt, state: "verified", file_id: result.file_id, error: undefined, updated_at: new Date().toISOString() });
  return { ...result, receipt_path: filename };
}

export interface ManifestItem { source: string; path: string; size: number; sha256: string }
export async function readManifest(filename: string): Promise<ManifestItem[]> {
  if ((await stat(filename)).size > 1024 * 1024) throw new LocalTransferError("MANIFEST_TOO_LARGE");
  const input = JSON.parse(await readFile(filename, "utf8"));
  if (!input || input.version !== 1 || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 100) throw new LocalTransferError("INVALID_MANIFEST");
  const seen = new Set<string>();
  return input.files.map((item: any) => {
    if (!item || typeof item.source !== "string" || !path.isAbsolute(item.source) || typeof item.path !== "string"
      || typeof item.sha256 !== "string" || typeof item.size !== "number") throw new LocalTransferError("INVALID_MANIFEST");
    validateExpectations({ signal: new AbortController().signal, expectedSize: item.size, expectedSha256: item.sha256 });
    const destination = remotePath(item.path);
    if (seen.has(destination)) throw new LocalTransferError("DUPLICATE_MANIFEST_DESTINATION");
    seen.add(destination);
    return { source: item.source, path: destination, size: item.size, sha256: item.sha256.toLowerCase() };
  });
}

export async function previewBatch(items: ManifestItem[], options: LocalTransferOptions) {
  const files = [];
  for (const item of items) {
    await inspectLocalSource(item.source, { ...options, expectedSize: item.size, expectedSha256: item.sha256 });
    files.push({ ...item, source_verified: true });
  }
  return { preview: true, files, total_bytes: items.reduce((n, item) => n + item.size, 0), destination_checked: false };
}

/** Preflight every source before starting any write. Never automatically resume an upload. */
export async function executeBatch(client: TransferClient, driveId: number, items: ManifestItem[], options: LocalTransferOptions, directory?: string) {
  await previewBatch(items, options);
  const files: Array<Record<string, unknown>> = [];
  let stopped = false;
  for (const item of items) {
    if (stopped || options.signal.aborted) { files.push({ path: item.path, status: "not_started" }); continue; }
    try {
      const result = await uploadWithReceipt(client, driveId, item.source, item.path,
        { ...options, expectedSize: item.size, expectedSha256: item.sha256 }, directory);
      files.push({ path: item.path, status: "verified", receipt_path: result.receipt_path, size_bytes: result.size_bytes, sha256: result.sha256 });
    } catch (error) {
      files.push({ path: item.path, status: "failed", error: transferErrorCode(error), ...(error instanceof LocalTransferError ? error.receipt : {}) });
      stopped = true;
    }
  }
  return { preview: false, verified: files.every(file => file.status === "verified"), files };
}
