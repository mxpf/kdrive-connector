import { DurableObject } from "cloudflare:workers";

export class KDriveOperationNonceStore extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS kdrive_operation_nonces (
				jti TEXT PRIMARY KEY,
				expires_at INTEGER NOT NULL
			)
		`);
	}

	async issue(jti: string, expiresAt: number): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM kdrive_operation_nonces WHERE expires_at < ?", Date.now());
		this.ctx.storage.sql.exec(
			"INSERT INTO kdrive_operation_nonces (jti, expires_at) VALUES (?, ?)",
			jti,
			expiresAt,
		);
	}

	async consume(jti: string, now: number): Promise<boolean> {
		const consumed = this.ctx.storage.sql.exec<{ jti: string }>(
			"DELETE FROM kdrive_operation_nonces WHERE jti = ? AND expires_at >= ? RETURNING jti",
			jti,
			now,
		).toArray();
		return consumed.length === 1;
	}
}
