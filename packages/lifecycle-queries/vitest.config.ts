import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    name: "lifecycle-queries",
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
    },
  },
});
