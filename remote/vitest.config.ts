import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ["test/**/*.test.ts"] },
	plugins: [cloudflareTest({
		// The production AI binding must never start a live proxy in unit tests.
		remoteBindings: false,
		wrangler: { configPath: "./wrangler.jsonc" },
		miniflare: { bindings: {
			KDRIVE_PDF_OCR_ENABLED: "false",
			KDRIVE_DRIVE_ID: "42",
			KDRIVE_ACCESS_TOKEN: "test-only-not-a-credential",
			KDRIVE_OPERATION_SECRET: "test-only-operation-secret-for-discovery",
		} },
	})],
});
