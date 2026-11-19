import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside a local copy of the Workers runtime with a fresh local D1. Nothing remote.
export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.jsonc" },
				// Never reach real Cloudflare services (Workers AI) from tests; graph tests use a fake model
				remoteBindings: false,
				miniflare: {
					bindings: { TEST_MIGRATIONS: migrations, ALLOWED_EMAIL: "owner@example.com" },
				},
			}),
		],
		test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
	};
});
