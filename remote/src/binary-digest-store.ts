import { DurableObject } from "cloudflare:workers";
import { assertVerifiedDigest, digestIdentityKey, DIGEST_CACHE_MAX_ENTRIES, DIGEST_CACHE_TTL_MS,
  type Digest, type DigestIdentity } from "../../src/binary-digest-cache.js";

/** Derived only from authenticated server context, not a tool argument. */
export function digestStoreName(owner: string, driveId: number): string {
  if (!owner || !Number.isSafeInteger(driveId) || driveId < 1) throw new Error("Invalid digest scope.");
  return JSON.stringify(["digest-v1", owner.toLowerCase(), driveId]);
}

/** A separate owner/drive Durable Object, independent of MCP session lifetime.
 * No public HTTP endpoint. Stores verified digests only; never grants access.
 */
export class KDriveBinaryDigestStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS binary_digests (
      identity TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
      expires_at INTEGER NOT NULL, last_used INTEGER NOT NULL
    )`);
  }

  private prune(): void {
    this.ctx.storage.sql.exec("DELETE FROM binary_digests WHERE expires_at <= ?", Date.now());
  }

  private nextUse(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COALESCE(MAX(last_used), 0) + 1 AS n FROM binary_digests").one().n;
  }

  private async scheduleExpiry(): Promise<void> {
    const expires = this.ctx.storage.sql.exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM binary_digests").one().next;
    if (expires === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(expires);
  }

  async getDigest(identity: DigestIdentity): Promise<Digest | undefined> {
    const key = digestIdentityKey(identity);
    this.prune();
    const entry = this.ctx.storage.sql.exec<Digest>("SELECT size_bytes, sha256 FROM binary_digests WHERE identity = ?", key).toArray()[0];
    if (!entry) return undefined;
    assertVerifiedDigest(identity, entry);
    this.ctx.storage.sql.exec("UPDATE binary_digests SET last_used = ? WHERE identity = ?", this.nextUse(), key);
    return { size_bytes: entry.size_bytes, sha256: entry.sha256 };
  }

  async putDigest(identity: DigestIdentity, digest: Digest): Promise<void> {
    assertVerifiedDigest(identity, digest);
    const key = digestIdentityKey(identity);
    // Keep writes + alarm updates serialized; no remote I/O is performed here.
    await this.ctx.blockConcurrencyWhile(async () => {
      this.prune();
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO binary_digests (identity, size_bytes, sha256, expires_at, last_used) VALUES (?, ?, ?, ?, ?)",
        key, digest.size_bytes, digest.sha256, Date.now() + DIGEST_CACHE_TTL_MS, this.nextUse());
      this.ctx.storage.sql.exec("DELETE FROM binary_digests WHERE identity IN (SELECT identity FROM binary_digests ORDER BY last_used DESC LIMIT -1 OFFSET ?)", DIGEST_CACHE_MAX_ENTRIES);
      await this.scheduleExpiry();
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => { this.prune(); await this.scheduleExpiry(); });
  }
}
