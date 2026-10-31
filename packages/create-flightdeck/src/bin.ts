import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
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
  openSecretFile: async (path) => {
    const handle = await open(path, "wx", 0o600);
    return {
      write: (contents) => handle.writeFile(contents),
      close: () => handle.close(),
      discard: async () => {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
      },
    };
  },
  randomBytes: (size) => randomBytes(size),
  now: Date.now,
});
