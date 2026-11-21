import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, FLIGHTDECK_DEV: "1" } },
      }),
    ],
    test: {
      name: "flightdeck",
      exclude: [
        ...configDefaults.exclude,
        "test/lifecycle-mcp-live.test.ts",
        "test/*.sqlite.test.*",
      ],
      setupFiles: ["./test/setup.ts"],
      // Projects ignore the root CLI's --testTimeout/--hookTimeout, so the slower Forgejo runner
      // needs them here (run 4 on ce58091: a 10 s beforeAll timeout in lifecycle-analytics-bridge).
      // CI only, and timeouts only: every test still runs and must pass.
      ...(process.env.CI ? { testTimeout: 60_000, hookTimeout: 60_000 } : {}),
    },
  };
});
