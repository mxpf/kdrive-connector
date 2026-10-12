import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, readFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalTransferError, LOCAL_MAX_BYTES, remotePath } from "./local-transfer.js";

export type TransferState = "preparing" | "uploading" | "committed" | "verified" | "unverified" | "unknown" | "failed";
export interface TransferReceipt {
  format: 1;
  id: string;
  drive_id: number;
  path: string;
  state: TransferState;
  updated_at: string;
  size_bytes?: number;
  sha256?: string;
  file_id?: number;
  error?: string;
}
export function journalDirectory() {
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "kdrive-connector", "transfers");
}

export async function saveReceipt(filename: string, receipt: TransferReceipt) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(receipt, null, 2) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, filename);
    const directory = await open(path.dirname(filename), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export async function newReceipt(driveId: number, destination: string, directory = journalDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new LocalTransferError("PRIVATE_RECEIPT_DIRECTORY_REQUIRED");
  const receipt: TransferReceipt = { format: 1, id: randomUUID(), drive_id: driveId, path: remotePath(destination), state: "preparing", updated_at: new Date().toISOString() };
  const filename = path.join(directory, `${receipt.id}.json`);
  await saveReceipt(filename, receipt);
  return { filename, receipt };
}

export async function readReceipt(filename: string): Promise<TransferReceipt> {
  const info = await lstat(filename);
  if (!info.isFile() || info.size > 16_384) throw new LocalTransferError("INVALID_RECEIPT");
  const r = JSON.parse(await readFile(filename, "utf8"));
  if (!r || r.format !== 1 || typeof r.id !== "string" || !/^[a-f0-9-]{36}$/.test(r.id)
    || !Number.isSafeInteger(r.drive_id) || r.drive_id < 1 || typeof r.path !== "string" || remotePath(r.path) !== r.path
    || !["preparing", "uploading", "committed", "verified", "unverified", "unknown", "failed"].includes(r.state)
    || typeof r.updated_at !== "string" || r.updated_at.length > 40 || !Number.isFinite(Date.parse(r.updated_at))
    || (r.size_bytes !== undefined && (!Number.isSafeInteger(r.size_bytes) || r.size_bytes < 1 || r.size_bytes > LOCAL_MAX_BYTES))
    || (r.sha256 !== undefined && (typeof r.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.sha256)))
    || (r.file_id !== undefined && (!Number.isSafeInteger(r.file_id) || r.file_id < 1))) throw new LocalTransferError("INVALID_RECEIPT");
  // Allowlist returned fields; never echo arbitrary JSON supplied as a receipt.
  return { format: 1, id: r.id, drive_id: r.drive_id, path: r.path, state: r.state, updated_at: r.updated_at,
    size_bytes: r.size_bytes, sha256: r.sha256, file_id: r.file_id,
    error: typeof r.error === "string" && /^[A-Z_]{1,80}$/.test(r.error) ? r.error : undefined };
}
