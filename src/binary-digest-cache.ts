export const DIGEST_CACHE_TTL_MS = 10 * 60_000;
export const DIGEST_CACHE_MAX_ENTRIES = 128;

export interface DigestIdentity {
  driveId: number;
  fileId: number;
  versionId: number | string;
  size: number;
}
type Digest = { size_bytes: number; sha256: string };

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
    return JSON.stringify([identity.driveId, identity.fileId, identity.versionId, identity.size]);
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
    if (!Number.isSafeInteger(identity.size) || identity.size < 0 || digest.size_bytes !== identity.size
      || !/^[a-f0-9]{64}$/.test(digest.sha256)) throw new Error("Invalid verified digest.");
    const now = this.now();
    for (const [key, entry] of this.entries) if (now >= entry.expiresAt) this.entries.delete(key);
    const key = this.key(identity);
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { digest: { size_bytes: digest.size_bytes, sha256: digest.sha256 }, expiresAt: now + this.ttlMs });
  }
}
