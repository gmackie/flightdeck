import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "apps/*",
      "apps/flightdeck/vitest.live.config.ts",
      "examples/lifecycle-outbox",
    ],
    passWithNoTests: true,
  },
});
