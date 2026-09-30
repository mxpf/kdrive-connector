import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [cloudflareTest({
		wrangler: { configPath: "./wrangler.jsonc" },
		miniflare: { bindings: {
			KDRIVE_DRIVE_ID: "42",
			KDRIVE_ACCESS_TOKEN: "test-only-not-a-credential",
			KDRIVE_OPERATION_SECRET: "test-only-operation-secret-for-discovery",
		} },
	})],
});
