#!/usr/bin/env node
// Lifecycle integration preflight and release gates. Local and read-only by default: it reads
// repository files, optionally runs allowlisted local commands (--run), never prints secret
// values and never calls Cloudflare, Flightdeck or any other remote API.
// See docs/operations/lifecycle-release-gates.md.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseRunList, runCommands } from "./lifecycle-preflight/lib/commands.mjs";
import {
  checkConfig,
  configFromEnv,
  evaluate,
  loadManifest,
  readConfigFile,
  UsageError,
} from "./lifecycle-preflight/lib/preflight.mjs";
import { redact } from "./lifecycle-preflight/lib/safety.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE_FLAGS = ["--remote", "--live", "--production", "--deploy", "--account", "--api-token"];

const HELP = `Usage: node scripts/lifecycle-preflight.mjs [options]

  --config <file>     Intended staging settings or a synthetic fixture (JSON, no secrets)
  --from-env          Also read allowlisted FLIGHTDECK_PREFLIGHT_* variables (no secrets)
  --run <ids|all>     Run allowlisted local commands: all, lint, typecheck, test, build,
                      pack-smoke, fixtures-test, fixtures-validate, wrangler-dry-run-flightdeck,
                      wrangler-dry-run-mcp, mcp-acceptance
  --out-dir <dir>     Where command logs go (default: a new temp directory)
  --report <file>     Also write the JSON report to this file
  --format <f>        text (default), json or markdown
  --require <v>       Exit 1 unless this verdict is ready: none (default),
                      integration-ready, production-safe
  --now <iso>         Evaluate attestation freshness at this time (default: now)
  --root <dir>        Repository root (default: this checkout)

Statuses: pass | blocked | unknown. Only pass is green; unknown never counts as passed.
Remote verification is not implemented; staging checks are manual (see the docs).
Exit codes: 0 report produced, 1 required verdict not ready, 2 usage or config error.`;

async function main(argv) {
  const remote = argv.find((a) => REMOTE_FLAGS.includes(a.split("=")[0]));
  if (remote) {
    throw new UsageError(
      `${remote.split("=")[0]}: remote and production checks are not implemented; this harness ` +
        "is local-only. Follow the manual staging checklist and record an attestation.",
    );
  }
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      config: { type: "string" },
      "from-env": { type: "boolean", default: false },
      run: { type: "string" },
      "out-dir": { type: "string" },
      report: { type: "string" },
      format: { type: "string", default: "text" },
      require: { type: "string", default: "none" },
      now: { type: "string" },
      root: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!["text", "json", "markdown"].includes(values.format))
    throw new UsageError("--format: text, json or markdown");
  if (!["none", "integration-ready", "production-safe"].includes(values.require)) {
    throw new UsageError("--require: none, integration-ready or production-safe");
  }
  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new UsageError("--now must be an ISO timestamp");

  const root = resolve(values.root ?? REPO);
  const manifest = loadManifest();
  let config = null;
  if (values.config || values["from-env"]) {
    const fromFile = values.config
      ? readConfigFile(values.config)
      : { kind: "flightdeck-lifecycle-preflight-config", version: 1 };
    const fromEnv = values["from-env"] ? configFromEnv(process.env) : {};
    config = checkConfig(merge(fromFile, fromEnv), manifest);
  }
  let ids = [];
  try {
    if (values.run !== undefined) ids = parseRunList(values.run);
  } catch (error) {
    throw new UsageError(error.message);
  }
  let commandResults = {};
  let outDir = null;
  if (ids.length) {
    outDir = values["out-dir"]
      ? resolve(values["out-dir"])
      : mkdtempSync(join(tmpdir(), "fd-preflight-"));
    mkdirSync(outDir, { recursive: true });
    process.stderr.write(`Running ${ids.join(", ")} (logs in ${outDir}/logs)\n`);
    commandResults = runCommands(ids, { root, outDir });
  }

  const result = await evaluate({ root, manifest, config, commandResults, now });
  const report = {
    kind: "flightdeck-lifecycle-preflight-report",
    version: 1,
    generatedAt: now.toISOString(),
    mode: "local-read-only",
    remoteCalls: "none",
    commit: result.head,
    config: config
      ? { source: values.config ? "file" : "env", environment: config.environment ?? null }
      : null,
    commands: Object.fromEntries(
      Object.entries(commandResults).map(([id, r]) => [
        id,
        { ...r, log: r.log ? r.log : undefined },
      ]),
    ),
    gates: result.gates,
    verdicts: result.verdicts,
    limits: [
      "No Cloudflare, Flightdeck, OAuth or Basin endpoint is contacted; live gates rely on operator attestations.",
      "Attestations are checked for shape, commit, freshness and synthetic flag, not independently verified.",
      "pnpm install and pack-smoke may contact the npm registry; no other network use is intended.",
    ],
  };
  if (values.report) writeFileSync(resolve(values.report), `${JSON.stringify(report, null, 2)}\n`);
  const rendered =
    values.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : values.format === "markdown"
        ? renderMarkdown(report)
        : renderText(report);
  process.stdout.write(redact(rendered));
  if (values.require !== "none" && report.verdicts[values.require].status !== "ready") return 1;
  return 0;
}

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v;
  }
  return out;
}

const ICON = { pass: "PASS", blocked: "BLOCKED", unknown: "UNKNOWN" };

function renderText(report) {
  const lines = [
    "Flightdeck lifecycle preflight (local, read-only, no remote calls)",
    `commit ${report.commit?.slice(0, 12) ?? "unknown"}  config ${report.config?.environment ?? "none"}  commands ${Object.keys(report.commands).length ? Object.keys(report.commands).join(",") : "not run"}`,
    "",
  ];
  const width = Math.max(...report.gates.map((g) => g.id.length));
  for (const gate of report.gates) {
    const req = gate.requiredFor.includes("integration-ready") ? "integration" : "production";
    lines.push(
      `${ICON[gate.status].padEnd(8)} ${gate.id.padEnd(width)}  ${req.padEnd(11)}  ${gate.reasons[0] ?? ""}`,
    );
    for (const reason of gate.reasons.slice(1)) lines.push(`${" ".repeat(width + 23)}${reason}`);
  }
  lines.push("");
  for (const [name, v] of Object.entries(report.verdicts)) {
    const detail = [
      v.blocking.length ? `blocked: ${v.blocking.join(", ")}` : "",
      v.unknown.length ? `unknown: ${v.unknown.join(", ")}` : "",
      ...v.notes,
    ].filter(Boolean);
    lines.push(
      `${name}: ${v.status.toUpperCase()}${detail.length ? `  (${detail.join("; ")})` : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderMarkdown(report) {
  const cell = (s) => String(s).replace(/\|/g, "\\|");
  const lines = [
    "## Lifecycle integration preflight",
    "",
    `Local and read-only; no remote calls. Commit \`${report.commit ?? "unknown"}\`, config \`${report.config?.environment ?? "none"}\`.`,
    "",
    "| Verdict | Status | Blocked | Unknown |",
    "| --- | --- | --- | --- |",
    ...Object.entries(report.verdicts).map(
      ([n, v]) =>
        `| ${n} | **${v.status}** | ${v.blocking.join(", ") || "-"} | ${v.unknown.join(", ") || "-"} |`,
    ),
    "",
    "| Gate | Status | Required for | Reasons |",
    "| --- | --- | --- | --- |",
    ...report.gates.map(
      (g) =>
        `| \`${g.id}\` | ${g.status} | ${g.requiredFor.join(", ")} | ${cell(g.reasons.join("; "))} |`,
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    const message =
      error instanceof UsageError || error?.code?.startsWith?.("ERR_PARSE_ARGS")
        ? error.message
        : `internal error (${error?.name ?? "unknown"})`;
    process.stderr.write(`lifecycle-preflight: ${redact(message)}\n`);
    process.exitCode = 2;
  },
);
