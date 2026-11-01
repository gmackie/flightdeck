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
      exclude: [...configDefaults.exclude, "test/lifecycle-mcp-live.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
