// All publishable packages (packages/* without "private") share one version.
//   node scripts/release-version.mjs set 0.2.0   rewrite every publishable package.json
//   node scripts/release-version.mjs check v0.2.0  exit 1 unless every package is at 0.2.0
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const root = new URL("../packages/", import.meta.url);

function packages() {
  return readdirSync(root)
    .map((dir) => new URL(`${dir}/package.json`, root))
    .flatMap((url) => {
      try {
        const text = readFileSync(url, "utf8");
        return [{ url, text, json: JSON.parse(text) }];
      } catch {
        return [];
      }
    })
    .filter((p) => !p.json.private);
}

const [command, arg] = process.argv.slice(2);
const version = arg?.replace(/^v/, "");
if (!["set", "check"].includes(command) || !version || !SEMVER.test(version)) {
  console.error("usage: release-version.mjs set|check <version>  (e.g. 0.2.0 or v0.2.0)");
  process.exit(2);
}

let mismatched = 0;
for (const { url, text, json } of packages()) {
  if (command === "set") {
    writeFileSync(url, text.replace(/"version": "[^"]*"/, `"version": "${version}"`));
    console.log(`${json.name}: ${json.version} -> ${version}`);
  } else if (json.version !== version) {
    console.error(`${json.name} is ${json.version}, expected ${version}`);
    mismatched++;
  } else {
    console.log(`${json.name}@${json.version}`);
  }
}
if (mismatched) process.exit(1);
