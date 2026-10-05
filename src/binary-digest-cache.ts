export const DIGEST_CACHE_TTL_MS = 10 * 60_000;
export const DIGEST_CACHE_MAX_ENTRIES = 128;
export const DIGEST_CACHE_OPERATION_TIMEOUT_MS = 1_000;

/** Cache RPC is optional and cannot hold an export open. This bounds the wait,
 * not the remote operation: a late verified write may still complete safely.
 */
export async function withinDigestCacheDeadline<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => reject(new Error("Digest cache deadline exceeded.")), DIGEST_CACHE_OPERATION_TIMEOUT_MS);
  });
  try {
    // Promise.race observes late RPC rejections as well as synchronous failures.
    return await Promise.race([Promise.resolve().then(operation), deadline]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export interface DigestIdentity {
  driveId: number;
  fileId: number;
  versionId: number | string;
  size: number;
}
export type Digest = { size_bytes: number; sha256: string };
export interface BinaryDigestStore {
  get(identity: DigestIdentity): Digest | undefined | Promise<Digest | undefined>;
  set(identity: DigestIdentity, digest: Digest): void | Promise<void>;
}

export function digestIdentityKey(identity: DigestIdentity): string {
  if (!identity || !Number.isSafeInteger(identity.driveId) || identity.driveId < 1
    || !Number.isSafeInteger(identity.fileId) || identity.fileId < 1
    || !Number.isSafeInteger(identity.size) || identity.size < 0
    || (typeof identity.versionId === "string" ? !identity.versionId.trim() || identity.versionId.length > 1024
      : !Number.isSafeInteger(identity.versionId) || identity.versionId < 1)) throw new Error("Invalid digest identity.");
  return JSON.stringify([identity.driveId, identity.fileId, identity.versionId, identity.size]);
}

export function assertVerifiedDigest(identity: DigestIdentity, digest: Digest): void {
  digestIdentityKey(identity);
  if (!digest || digest.size_bytes !== identity.size || typeof digest.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(digest.sha256)) throw new Error("Invalid verified digest.");
}

/** Owned by one authenticated tool registration, never shared across clients.
 * Stores only verified digests, not bytes, credentials, paths or signed URLs.
 * Callers must freshly resolve/authorize the exact file/version before get().
 */
export class BinaryDigestCache {
  private readonly entries = new Map<string, { digest: Digest; expiresAt: number }>();

  constructor(private readonly maxEntries = DIGEST_CACHE_MAX_ENTRIES,
    private readonly ttlMs = DIGEST_CACHE_TTL_MS, private readonly now = Date.now) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new Error("Invalid digest cache limits.");
    }
  }

  private key(identity: DigestIdentity): string {
    return digestIdentityKey(identity);
  }

  get(identity: DigestIdentity): Digest | undefined {
    const key = this.key(identity);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (this.now() >= entry.expiresAt) return undefined;
    this.entries.set(key, entry); // LRU promotion does not extend expiry.
    return { ...entry.digest };
  }

  set(identity: DigestIdentity, digest: Digest): void {
    assertVerifiedDigest(identity, digest);
    const now = this.now();
    for (const [key, entry] of this.entries) if (now >= entry.expiresAt) this.entries.delete(key);
    const key = this.key(identity);
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { digest: { size_bytes: digest.size_bytes, sha256: digest.sha256 }, expiresAt: now + this.ttlMs });
  }
}
