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
          bindings: { TEST_MIGRATIONS: migrations },
          // The FLIGHTDECK binding needs a `flightdeck` service; tests pass a contract fake instead.
          workers: [
            {
              name: "flightdeck",
              modules: true,
              compatibilityDate: "2026-10-30",
              script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class Ingest extends WorkerEntrypoint {}
export default { fetch: () => new Response(null, { status: 404 }) };`,
            },
          ],
        },
      }),
    ],
    test: { name: "lifecycle-outbox", setupFiles: ["./test/setup.ts"] },
  };
});
