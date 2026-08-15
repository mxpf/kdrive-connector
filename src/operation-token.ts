import { Buffer } from "node:buffer";

const TOKEN_VERSION = 1;
const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

export type KDriveOperationAction = "rename" | "move" | "overwrite" | "trash";

export interface OperationTokenPayload {
  v: typeof TOKEN_VERSION;
  type: "operation";
  jti: string;
  action: KDriveOperationAction;
  driveId: number;
  sourceId: number;
  sourcePath: string;
  sourceEtag?: string;
  name?: string;
  destinationId?: number;
  destinationPath?: string;
  contentDigest?: string;
  issuedAt: number;
  expiresAt: number;
}

export interface RestoreTokenPayload {
  v: typeof TOKEN_VERSION;
  type: "restore";
  driveId: number;
  fileId: number;
  destinationDirectoryId: number;
  originalPath: string;
  issuedAt: number;
  expiresAt: number;
}

export interface OpenTokenPayload {
  v: typeof TOKEN_VERSION;
  type: "open";
  driveId: number;
  fileId: number;
  path: string;
  issuedAt: number;
  expiresAt: number;
}

export type KDriveSignedPayload = OperationTokenPayload | RestoreTokenPayload | OpenTokenPayload;

export interface OperationNonceStore {
  issue(jti: string, expiresAt: number): Promise<void> | void;
  consume(jti: string, now: number): Promise<boolean> | boolean;
}

export class MemoryOperationNonceStore implements OperationNonceStore {
  private readonly nonces = new Map<string, number>();

  issue(jti: string, expiresAt: number): void {
    this.deleteExpired(Date.now());
    this.nonces.set(jti, expiresAt);
  }

  consume(jti: string, now: number): boolean {
    this.deleteExpired(now);
    const expiresAt = this.nonces.get(jti);
    if (expiresAt === undefined || expiresAt < now) return false;
    this.nonces.delete(jti);
    return true;
  }

  private deleteExpired(now: number): void {
    for (const [jti, expiresAt] of this.nonces) {
      if (expiresAt < now) this.nonces.delete(jti);
    }
  }
}

function encodeBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function copyToArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    HMAC_ALGORITHM,
    false,
    ["sign", "verify"],
  );
}

function assertSafePositiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`Invalid ${name} in signed token.`);
}

function assertTimestamp(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`Invalid ${name} in signed token.`);
}

function assertBasePayload(value: unknown): asserts value is KDriveSignedPayload {
  if (!value || typeof value !== "object") throw new Error("Invalid signed token payload.");
  const payload = value as Partial<KDriveSignedPayload>;
  if (payload.v !== TOKEN_VERSION) throw new Error("Unsupported signed token version.");
  if (payload.type !== "operation" && payload.type !== "restore" && payload.type !== "open") {
    throw new Error("Invalid signed token type.");
  }
  assertSafePositiveInteger(payload.driveId, "drive ID");
  assertTimestamp(payload.issuedAt, "issue time");
  assertTimestamp(payload.expiresAt, "expiry time");
}

function assertNotExpired(payload: KDriveSignedPayload, now: number): void {
  if (payload.expiresAt < now) throw new Error("This prepared kDrive action expired. Prepare it again.");
  if (payload.issuedAt > now + 60_000) throw new Error("The signed token issue time is invalid.");
}

export function generateOperationSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", copyToArrayBuffer(bytes))));
}

export async function signKDrivePayload(secret: string, payload: KDriveSignedPayload): Promise<string> {
  if (!secret) throw new Error("The kDrive operation signing secret is not configured.");
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    HMAC_ALGORITHM,
    await importSigningKey(secret),
    new TextEncoder().encode(encodedPayload),
  );
  return `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyKDrivePayload(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<KDriveSignedPayload> {
  if (!secret) throw new Error("The kDrive operation signing secret is not configured.");
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) throw new Error("Invalid signed kDrive token.");
  const verified = await crypto.subtle.verify(
    HMAC_ALGORITHM,
    await importSigningKey(secret),
    copyToArrayBuffer(decodeBase64Url(encodedSignature)),
    new TextEncoder().encode(encodedPayload),
  );
  if (!verified) throw new Error("Invalid signed kDrive token.");

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid signed kDrive token payload.");
  }
  assertBasePayload(payload);
  assertNotExpired(payload, now);
  return payload;
}

export function createOperationPayload(
  input: Omit<OperationTokenPayload, "v" | "type" | "jti" | "issuedAt" | "expiresAt">,
  ttlMs: number,
  now = Date.now(),
): OperationTokenPayload {
  return {
    v: TOKEN_VERSION,
    type: "operation",
    jti: crypto.randomUUID(),
    ...input,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
}

export function createRestorePayload(
  input: Omit<RestoreTokenPayload, "v" | "type" | "issuedAt" | "expiresAt">,
  ttlMs: number,
  now = Date.now(),
): RestoreTokenPayload {
  return { v: TOKEN_VERSION, type: "restore", ...input, issuedAt: now, expiresAt: now + ttlMs };
}

export function createOpenPayload(
  input: Omit<OpenTokenPayload, "v" | "type" | "issuedAt" | "expiresAt">,
  ttlMs: number,
  now = Date.now(),
): OpenTokenPayload {
  return { v: TOKEN_VERSION, type: "open", ...input, issuedAt: now, expiresAt: now + ttlMs };
}

export function assertOperationPayload(
  payload: KDriveSignedPayload,
  action: KDriveOperationAction,
  driveId: number,
): asserts payload is OperationTokenPayload {
  if (payload.type !== "operation" || payload.action !== action || payload.driveId !== driveId) {
    throw new Error("The prepared kDrive action does not match this request.");
  }
  if (!payload.jti || typeof payload.jti !== "string") throw new Error("Invalid operation nonce.");
  assertSafePositiveInteger(payload.sourceId, "source ID");
  if (!payload.sourcePath || typeof payload.sourcePath !== "string") throw new Error("Invalid source path.");
  if (normalizeSignedPath(payload.sourcePath) !== payload.sourcePath) throw new Error("Invalid normalized source path.");
  if (action === "move") {
    assertSafePositiveInteger(payload.destinationId, "destination ID");
    if (!payload.destinationPath || typeof payload.destinationPath !== "string") {
      throw new Error("Invalid destination path.");
    }
    if (normalizeSignedPath(payload.destinationPath) !== payload.destinationPath) {
      throw new Error("Invalid normalized destination path.");
    }
  }
  if (action === "rename" && (!payload.name || typeof payload.name !== "string")) {
    throw new Error("Invalid rename target.");
  }
  if (action === "overwrite" && (!payload.contentDigest || typeof payload.contentDigest !== "string")) {
    throw new Error("Invalid replacement content digest.");
  }
}

export function assertRestorePayload(
  payload: KDriveSignedPayload,
  driveId: number,
): asserts payload is RestoreTokenPayload {
  if (payload.type !== "restore" || payload.driveId !== driveId) throw new Error("This undo token is not valid here.");
  assertSafePositiveInteger(payload.fileId, "file ID");
  assertSafePositiveInteger(payload.destinationDirectoryId, "restore destination ID");
  if (!payload.originalPath || typeof payload.originalPath !== "string") throw new Error("Invalid restore path.");
}

function normalizeSignedPath(path: string): string {
  const segments = path.trim().split("/").filter(Boolean).map((segment) => segment.normalize("NFC"));
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function assertOpenPayload(payload: KDriveSignedPayload): asserts payload is OpenTokenPayload {
  if (payload.type !== "open") throw new Error("This is not a valid kDrive open link.");
  assertSafePositiveInteger(payload.fileId, "file ID");
  if (!payload.path || typeof payload.path !== "string") throw new Error("Invalid open-link path.");
}
