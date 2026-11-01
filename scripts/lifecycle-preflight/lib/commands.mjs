// The only processes the preflight starts. Each is a fixed argv run without a shell, from a fixed
// directory, with a credential-free environment. Nothing from --config or the manifest reaches an
// argv, so a hostile config cannot inject a command.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, redact } from "./safety.mjs";

const node = process.execPath;

/** id -> { argv, cwd (repo-relative), requires (repo path that must exist), wrangler } */
export const COMMANDS = Object.freeze({
  lint: { argv: ["pnpm", "lint"], cwd: "." },
  typecheck: { argv: ["pnpm", "typecheck"], cwd: "." },
  test: { argv: ["pnpm", "test"], cwd: "." },
  build: { argv: ["pnpm", "build"], cwd: "." },
  "pack-smoke": { argv: ["pnpm", "smoke:pack"], cwd: "." },
  "fixtures-test": {
    argv: [node, "--test", "test/*.test.mjs"],
    cwd: "examples/lifecycle-fixtures",
    requires: "examples/lifecycle-fixtures/cli.mjs",
  },
  "fixtures-validate": {
    argv: [node, "cli.mjs", "validate", "--fixtures"],
    cwd: "examples/lifecycle-fixtures",
    requires: "examples/lifecycle-fixtures/cli.mjs",
  },
  "wrangler-dry-run-flightdeck": {
    argv: ["pnpm", "exec", "wrangler", "deploy", "--dry-run", "--outdir", "{out}"],
    cwd: "apps/flightdeck",
    requires: "apps/flightdeck/wrangler.jsonc",
    wrangler: true,
  },
  "wrangler-dry-run-mcp": {
    argv: ["pnpm", "exec", "wrangler", "deploy", "--dry-run", "--outdir", "{out}"],
    cwd: "apps/lifecycle-mcp",
    requires: "apps/lifecycle-mcp/wrangler.jsonc",
    wrangler: true,
  },
  "mcp-acceptance": {
    argv: [
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--project",
      "lifecycle-mcp",
      "apps/lifecycle-mcp/test/acceptance.test.ts",
    ],
    cwd: ".",
    requires: "apps/lifecycle-mcp/test/acceptance.test.ts",
  },
});

/** Commands run in this order so build output exists before the dry runs need it. */
export const COMMAND_ORDER = Object.keys(COMMANDS);

/** Parses `--run a,b` (or `all`) strictly against the allowlist. Throws on anything else. */
export function parseRunList(raw) {
  if (raw === "all") return [...COMMAND_ORDER];
  const ids = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("--run needs at least one command id");
  for (const id of ids) {
    if (!/^[a-z0-9-]{1,40}$/.test(id) || !Object.hasOwn(COMMANDS, id)) {
      throw new Error(`--run: unknown command id (allowed: all, ${COMMAND_ORDER.join(", ")})`);
    }
  }
  return COMMAND_ORDER.filter((id) => ids.includes(id));
}

/**
 * Runs the selected commands. Output is redacted and written to `<outDir>/logs/<id>.log`; only
 * the status, duration and log path come back. `spawn` is injectable for tests.
 */
export function runCommands(ids, { root, outDir, timeoutMs = 30 * 60_000, spawn = spawnSync }) {
  const results = {};
  const logs = join(outDir, "logs");
  mkdirSync(logs, { recursive: true });
  for (const id of ids) {
    const spec = COMMANDS[id];
    if (spec.requires && !existsSync(join(root, spec.requires))) {
      results[id] = { status: "missing", reason: `${spec.requires} not in this tree` };
      continue;
    }
    const wranglerHome = spec.wrangler ? mkdtempSync(join(tmpdir(), "fd-preflight-xdg-")) : null;
    const argv = spec.argv.map((arg) => (arg === "{out}" ? join(outDir, "wrangler", id) : arg));
    const started = Date.now();
    const run = spawn(argv[0], argv.slice(1), {
      cwd: join(root, spec.cwd),
      env: childEnv(process.env, { isolatedConfigHome: wranglerHome }),
      shell: false,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = join(logs, `${id}.log`);
    const display = argv.map((a) => (a === node ? "node" : a)).join(" ");
    writeFileSync(log, redact(`$ ${display}\n${run.stdout ?? ""}\n${run.stderr ?? ""}`), "utf8");
    const ok = run.status === 0 && !run.error;
    results[id] = {
      status: ok ? "passed" : "failed",
      exitCode: run.status ?? null,
      reason: run.error ? run.error.code || "spawn-error" : undefined,
      durationMs: Date.now() - started,
      log,
    };
  }
  return results;
}
