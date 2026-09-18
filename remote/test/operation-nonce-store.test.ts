import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("KDriveOperationNonceStore", () => {
	it("issues each operation nonce for one successful consumption", async () => {
		const store = env.KDRIVE_OPERATION_NONCES.getByName(`nonce-${crypto.randomUUID()}`);
		const now = Date.now();
		await store.issue("single-use", now + 60_000);

		expect(await store.consume("single-use", now)).toBe(true);
		expect(await store.consume("single-use", now)).toBe(false);
	});

	it("rejects an expired operation nonce", async () => {
		const store = env.KDRIVE_OPERATION_NONCES.getByName(`expired-${crypto.randomUUID()}`);
		const now = Date.now();
		await store.issue("expired", now - 1);

		expect(await store.consume("expired", now)).toBe(false);
	});
});
