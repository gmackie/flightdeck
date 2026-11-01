import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            FLIGHTDECK_DEV: "1",
            ACCESS_TEAM_DOMAIN: "https://mcp-live.cloudflareaccess.com",
            ACCESS_AUD: "dashboard-aud",
            LIFECYCLE_MCP_READ_ENABLED: "1",
            LIFECYCLE_MCP_ACCESS_AUD: "mcp-aud",
            LIFECYCLE_PRIVACY_MODE: "enforce",
            LIFECYCLE_PRIVACY_RESTRICTED: "deny",
            LIFECYCLE_PRIVACY_KEY: "synthetic-only-stable-key-32-characters",
          },
          serviceBindings: {
            TEST_LIFECYCLE_READ: { name: "flightdeck", entrypoint: "LifecycleReadEntrypoint" },
          },
        },
      }),
    ],
    test: {
      name: "flightdeck-mcp-live",
      include: ["test/lifecycle-mcp-live.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
