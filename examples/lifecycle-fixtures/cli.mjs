#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
// Synthetic lifecycle fixtures: generate, validate, simulate. See README.md.
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  baselineFailures,
  checkScenario,
  checkScenarioShape,
  compareToExpected,
} from "./lib/check.mjs";
import { coverage, missing } from "./lib/coverage.mjs";
import { DEFAULT_APPS, generate, PROFILES } from "./lib/generate.mjs";
import { goldenDigest } from "./lib/golden.mjs";
import { PROCESS_NAMES } from "./lib/processes.mjs";
import { Reducer, summarize } from "./lib/reduce.mjs";
import { buildScenarios } from "./lib/scenarios.mjs";
import { checkpointReport, deliveryReport, scopeReport } from "./lib/simulate.mjs";
import { diff, parseDuration, parseIso, parseSize } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, "fixtures", "scenarios");
const GOLDEN_FILE = join(HERE, "fixtures", "golden.json");

const USAGE = `lifecycle-fixtures: deterministic synthetic lifecycle events (no production data)

  node cli.mjs generate --seed <s> --size <1k|100k|1m|N> [--out <dir>] [options]
  node cli.mjs validate <dir|events.ndjson|scenario.json> [--expected <file>] [--scope] [--coverage]
  node cli.mjs validate --fixtures
  node cli.mjs simulate <events.ndjson> [--late-after 1h] [--checkpoints 6]
  node cli.mjs fixtures (--write | --check)

generate options:
  --profile <clean|default|hostile>  delivery noise (default: default)
  --apps <spec>   e.g. app_a=recruiting,app_b=service_delivery+incident_response
                  processes: ${PROCESS_NAMES.join(", ")}
  --id-seed <s>   ids come from this seed; apps share it so ids collide across apps (default: derived from --seed)
  --distinct-ids  give each app its own id stream (no cross-app id collisions)
  --span-days <n> observation window (default 120)   --start <ISO>
  --detail        include per-entity ground truth in expected.json
`;

function parseArgs(argv) {
  const args = { _: [] };
  const flags = new Set([
    "detail",
    "scope",
    "coverage",
    "fixtures",
    "write",
    "check",
    "json",
    "distinct-ids",
    "help",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) args._.push(a);
    else {
      const key = a.slice(2);
      if (flags.has(key)) args[key] = true;
      else {
        if (argv[i + 1] === undefined) throw new Error(`--${key} needs a value`);
        args[key] = argv[++i];
      }
    }
  }
  return args;
}

function parseApps(spec) {
  if (!spec) return DEFAULT_APPS;
  return spec.split(",").map((part) => {
    const [appId, procs] = part.split("=");
    if (!appId || !procs)
      throw new Error(`bad --apps entry ${JSON.stringify(part)} (want app_id=process+process)`);
    return { appId, processes: procs.split("+") };
  });
}

// ---------------------------------------------------------------------------------------------

async function cmdGenerate(args) {
  if (!args.seed) throw new Error("--seed is required");
  const events = parseSize(args.size ?? args.events ?? "1k");
  const apps = parseApps(args.apps);
  const profile = args.profile ?? "default";
  if (!PROFILES[profile])
    throw new Error(`unknown --profile ${profile} (${Object.keys(PROFILES).join(", ")})`);
  const cfg = {
    seed: args.seed,
    events,
    apps,
    profile,
    ...(args["id-seed"] ? { idSeed: args["id-seed"] } : {}),
    ...(args.start ? { start: args.start } : {}),
    ...(args["span-days"] ? { spanDays: Number(args["span-days"]) } : {}),
  };
  if (args["distinct-ids"]) cfg.distinctIds = true;
  const out = resolve(
    args.out ?? join(HERE, "out", `${args.seed}-${args.size ?? args.events ?? "1k"}`),
  );
  mkdirSync(out, { recursive: true });

  const g = generate(cfg);
  const eventsPath = join(out, "events.ndjson");
  const hash = createHash("sha256");
  const stream = createWriteStream(eventsPath);
  const CHUNK = 10_000;
  for (let i = 0; i < g.records.length; i += CHUNK) {
    const text = `${g.records
      .slice(i, i + CHUNK)
      .map((r) => JSON.stringify(r))
      .join("\n")}\n`;
    hash.update(text);
    if (!stream.write(text)) await new Promise((r) => stream.once("drain", r));
  }
  await new Promise((r) => stream.end(r));

  const expected = { ...g.truth, ...(args.detail ? { entities: g.entities } : {}) };
  writeFileSync(join(out, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
  const manifest = {
    tool: "flightdeck-lifecycle-fixtures",
    synthetic: true,
    params: g.params,
    deliveries: g.records.length,
    entities: g.entities.length,
    eventsSha256: hash.digest("hex"),
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`generated ${g.records.length} deliveries, ${g.entities.length} entities -> ${out}`);
  console.log(`events sha256 ${manifest.eventsSha256}`);
}

// ---------------------------------------------------------------------------------------------

async function loadNdjson(path) {
  const records = [];
  const rl = createInterface({
    input: createReadStream(path, "utf8"),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      records.push({ receivedAt: null, event: undefined, unparseable: true });
    }
  }
  return records;
}

/** Delivery-stream checks that are about the transport, not the events. */
function transportFailures(records) {
  const out = [];
  let last = 0;
  let regressions = 0;
  for (const r of records) {
    const t = parseIso(r?.receivedAt);
    if (Number.isNaN(t)) {
      out.push("a record has no valid receivedAt");
      break;
    }
    if (t < last) regressions++;
    last = Math.max(last, t);
  }
  if (regressions)
    out.push(`receivedAt decreases ${regressions}x (the file must be in delivery order)`);
  return out;
}

async function validateDataset(path, args) {
  const failures = [];
  const dir = statSync(path).isDirectory() ? path : dirname(path);
  const eventsPath = statSync(path).isDirectory() ? join(path, "events.ndjson") : path;
  const expectedPath = args.expected ? resolve(args.expected) : join(dir, "expected.json");
  const expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, "utf8")) : null;

  const records = await loadNdjson(eventsPath);
  failures.push(...transportFailures(records));
  const reducer = new Reducer();
  for (const r of records) reducer.add(r);
  const red = reducer.finish(expected?.asOf ? { asOf: parseIso(expected.asOf) } : {});
  failures.push(...baselineFailures(red));
  if (expected) {
    failures.push(...compareToExpected(red, expected));
    if (expected.entities && args.detail !== false) {
      const d = diff(
        JSON.parse(JSON.stringify(red.entities)),
        expected.entities,
        "entities",
        [],
        5,
      );
      if (d.length && !failures.some((f) => f.startsWith("entities"))) failures.push(...d);
    }
  } else console.log("note: no expected.json found; only baseline invariants were checked");
  if (args.scope) {
    const scope = scopeReport(records, { asOf: red.asOf });
    if (!scope.isolated)
      failures.push(
        `app scope leak: ${scope.isolationMismatches.join(", ")} differ when reduced alone`,
      );
    console.log(
      `scope: ${scope.apps.length} apps, ${scope.eventIdsSharedAcrossApps} eventIds and ${scope.entityIdsSharedAcrossApps} entity ids reused across apps, isolated=${scope.isolated}`,
    );
  }
  if (args.coverage) {
    const cov = coverage(records, red, summaryOf(red));
    const gaps = missing(cov);
    console.log(
      `coverage: ${Object.keys(cov).length - gaps.length}/${Object.keys(cov).length} features exercised${gaps.length ? `; not exercised: ${gaps.join(", ")}` : ""}`,
    );
  }
  console.log(
    `${eventsPath}: ${red.totals.deliveries} deliveries, ${red.entities.length} entities, ${red.totals.invalid.count} invalid, ` +
      `${red.totals.duplicateDeliveries} duplicate, ${red.totals.corrections} corrections, ${red.violations.length} violations`,
  );
  return failures;
}

const summaryOf = (red) => summarize(red.entities, red.asOf);

function validateScenarioFile(path) {
  const sc = JSON.parse(readFileSync(path, "utf8"));
  const file = path.split("/").pop();
  const shape = checkScenarioShape(sc, file);
  return shape.length ? shape : checkScenario(sc);
}

function validateCommitted() {
  const failures = [];
  const files = existsSync(SCENARIO_DIR)
    ? readdirSync(SCENARIO_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];
  if (files.length === 0)
    failures.push("no scenario fixtures found; run `node cli.mjs fixtures --write`");
  for (const f of files) {
    const bad = validateScenarioFile(join(SCENARIO_DIR, f));
    console.log(`${bad.length ? "FAIL" : "ok  "} scenario ${f}`);
    failures.push(...bad.map((m) => `${f}: ${m}`));
  }
  const built = buildScenarios();
  for (const sc of built) {
    const p = join(SCENARIO_DIR, `${sc.name}.json`);
    if (!existsSync(p)) failures.push(`missing fixture ${sc.name}.json`);
    else if (JSON.stringify(JSON.parse(readFileSync(p, "utf8"))) !== JSON.stringify(sc)) {
      failures.push(`${sc.name}.json is stale; run \`node cli.mjs fixtures --write\``);
    }
  }
  const extra = files.filter((f) => !built.some((s) => `${s.name}.json` === f));
  for (const f of extra) failures.push(`${f} is not produced by the scenario builders`);

  if (!existsSync(GOLDEN_FILE)) failures.push("fixtures/golden.json missing");
  else {
    const want = JSON.parse(readFileSync(GOLDEN_FILE, "utf8"));
    const got = goldenDigest();
    const d = diff(got, want, "golden");
    console.log(`${d.length ? "FAIL" : "ok  "} golden 1k seed ${got.config.seed}`);
    failures.push(
      ...d.map((m) => `${m} (generator output changed; if intended run \`fixtures --write\`)`),
    );
  }
  return failures;
}

async function cmdValidate(args) {
  let failures;
  if (args.fixtures) failures = validateCommitted();
  else {
    const target = args._[1];
    if (!target) throw new Error("validate needs a path (or --fixtures)");
    const path = resolve(target);
    if (!existsSync(path)) throw new Error(`${path} does not exist`);
    failures =
      path.endsWith(".json") && !statSync(path).isDirectory()
        ? validateScenarioFile(path)
        : await validateDataset(path, args);
  }
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} problem(s)`);
    for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else console.log("\nPASS");
}

// ---------------------------------------------------------------------------------------------

async function cmdSimulate(args) {
  const path = args._[1];
  if (!path) throw new Error("simulate needs an events.ndjson path");
  const records = await loadNdjson(resolve(path));
  const lateAfterMs = parseDuration(args["late-after"] ?? "1h");
  const delivery = deliveryReport(records, { lateAfterMs });
  const checkpoints = checkpointReport(records, { checkpoints: Number(args.checkpoints ?? 6) });
  const scope = scopeReport(records);
  if (args.json) {
    console.log(JSON.stringify({ delivery, checkpoints, scope }, null, 2));
    return;
  }
  const s = (ms) =>
    ms === null
      ? "-"
      : ms < 60_000
        ? `${(ms / 1000).toFixed(1)}s`
        : ms < 86_400_000
          ? `${(ms / 3_600_000).toFixed(1)}h`
          : `${(ms / 86_400_000).toFixed(1)}d`;
  console.log(
    `delivery: ${delivery.records} records, ${delivery.lateEvents} late (>${s(lateAfterMs)}, ${(delivery.lateRate * 100).toFixed(1)}%)`,
  );
  console.log(
    `  lag p50 ${s(delivery.lagMs.p50)}  p95 ${s(delivery.lagMs.p95)}  p99 ${s(delivery.lagMs.p99)}  max ${s(delivery.lagMs.max)}`,
  );
  console.log(
    `  out-of-order: ${delivery.outOfOrderDeliveries} deliveries across ${delivery.outOfOrderEntities} entities`,
  );
  console.log("\nknown-by-delivery vs happened-by-occurrence (the cost of late ingestion):");
  console.log("  checkpoint                 in-flight  entities(del/occ)  closed(del/occ)  gaps");
  for (const r of checkpoints) {
    console.log(
      `  ${r.at}  ${String(r.eventsStillInFlight).padStart(9)}  ${`${r.entitiesByDelivery}/${r.entitiesByOccurrence}`.padStart(17)}  ${`${r.closedByDelivery}/${r.closedByOccurrence}`.padStart(15)}  ${String(r.entitiesWithVersionGaps).padStart(4)}`,
    );
  }
  const finalRow = checkpoints[checkpoints.length - 1];
  const converged =
    finalRow &&
    finalRow.eventsStillInFlight === 0 &&
    finalRow.closedByDelivery === finalRow.closedByOccurrence;
  console.log(`  final checkpoint converged: ${converged}`);
  console.log(
    `\nscope: apps=${scope.apps.join(",")} sharedEventIds=${scope.eventIdsSharedAcrossApps} sharedEntityIds=${scope.entityIdsSharedAcrossApps} isolated=${scope.isolated}`,
  );
  if (!converged || !scope.isolated) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------------

function cmdFixtures(args) {
  if (args.check) {
    const failures = validateCommitted();
    if (failures.length) {
      console.error(`\nFAIL:\n  - ${failures.join("\n  - ")}`);
      process.exitCode = 1;
    } else console.log("\nPASS: committed fixtures match the builders");
    return;
  }
  if (!args.write) throw new Error("fixtures needs --write or --check");
  mkdirSync(SCENARIO_DIR, { recursive: true });
  for (const sc of buildScenarios()) {
    const bad = [...checkScenarioShape(sc, `${sc.name}.json`), ...checkScenario(sc)];
    if (bad.length)
      throw new Error(
        `scenario ${sc.name} does not satisfy its own expectations:\n  ${bad.join("\n  ")}`,
      );
    writeFileSync(join(SCENARIO_DIR, `${sc.name}.json`), `${JSON.stringify(sc, null, 2)}\n`);
  }
  writeFileSync(GOLDEN_FILE, `${JSON.stringify(goldenDigest(), null, 2)}\n`);
  // Keep the committed JSON in the repo's lint format when the repo's biome is installed.
  const biome = resolve(HERE, "..", "..", "node_modules", ".bin", "biome");
  if (existsSync(biome))
    spawnSync(biome, ["format", "--write", join(HERE, "fixtures")], { stdio: "ignore" });
  console.log(`wrote ${buildScenarios().length} scenarios and golden.json`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (!cmd || args.help) console.log(USAGE);
  else if (cmd === "generate") await cmdGenerate(args);
  else if (cmd === "validate") await cmdValidate(args);
  else if (cmd === "simulate") await cmdSimulate(args);
  else if (cmd === "fixtures") cmdFixtures(args);
  else throw new Error(`unknown command ${cmd}\n\n${USAGE}`);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 2;
}
