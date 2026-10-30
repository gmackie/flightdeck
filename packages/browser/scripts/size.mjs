import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const LIMIT = 3 * 1024;
const out = await build({
  entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
  bundle: true,
  minify: true,
  format: "esm",
  write: false,
});
const gz = gzipSync(out.outputFiles[0].contents).length;
console.log(`@flightdeckhq/browser: ${gz} B gzip (limit ${LIMIT})`);
if (gz > LIMIT) process.exit(1);
