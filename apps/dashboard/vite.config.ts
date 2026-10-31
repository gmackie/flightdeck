import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `wrangler dev` (apps/flightdeck) serves the API and the dogfood endpoint on :8787.
const worker = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": worker, "/_fd": worker, "/__dev": worker } },
  // Kumo (with Base UI) and React make one ~180 kB gzip bundle; fine for an internal dashboard.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 800 },
});
