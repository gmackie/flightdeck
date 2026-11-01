import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "flightdeck-sqlite",
    environment: "node",
    include: ["test/lifecycle-repository.sqlite.test.js"],
  },
});
