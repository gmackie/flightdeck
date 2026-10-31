import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { main } from "./cli";

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  fetch,
  exec: (command, args) =>
    new Promise((resolve, reject) =>
      execFile(command, args, { timeout: 30_000 }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      ),
    ),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  writeSecretFile: (path, contents) => writeFile(path, contents, { mode: 0o600, flag: "wx" }),
  randomBytes: (size) => randomBytes(size),
  now: Date.now,
});
