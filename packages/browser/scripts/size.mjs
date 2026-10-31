import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const LIMIT = 3 * 1024;
// Measure the published build (dist), bundled and minified the way an app's bundler would.
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
if (!existsSync(entry)) {
  console.error("@flightdeckhq/browser: dist/index.js is missing; run `pnpm build` first");
  process.exit(1);
}
const out = await build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: "esm",
  write: false,
});
const gz = gzipSync(out.outputFiles[0].contents).length;
console.log(`@flightdeckhq/browser: ${gz} B gzip (limit ${LIMIT})`);
if (gz > LIMIT) process.exit(1);
