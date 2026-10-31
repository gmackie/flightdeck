import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: { name: "dashboard", environment: "happy-dom", setupFiles: ["./test/setup.ts"] },
});
