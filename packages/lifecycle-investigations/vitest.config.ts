import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    name: "lifecycle-investigations",
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
    },
  },
});
