import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { COMMANDS, parseRunList, runCommands } from "../lib/commands.mjs";
import { checkConfig, configFromEnv } from "../lib/preflight.mjs";
import { childEnv, findSecrets, looksSecret, redact, resolveInside } from "../lib/safety.mjs";
import { parseJsonc, validate } from "../lib/schema.mjs";
import { CLI, FIXTURE_CONFIG, makeRepo, manifest, REPO } from "./helpers.mjs";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJlLXZhbHVl";
const TOKEN = "Zx9Qm2Lp8Vt4Rk7Hs1Nd6Gf3Jw5Bc0Ya";
const fixture = () => JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
const cli = (args, opts = {}) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
    encoding: "utf8",
    cwd: REPO,
    ...opts,
  });

describe("config allowlist", () => {
  it("accepts the committed synthetic fixture", () => {
    assert.doesNotThrow(() => checkConfig(fixture(), manifest));
  });

  it("rejects unknown flags, invalid values and unknown keys", () => {
    const bad = (mutate) => {
      const c = fixture();
      mutate(c);
      return () => checkConfig(c, manifest);
    };
    assert.throws(
      bad((c) => {
        c.flags.LIFECYCLE_MCP_YOLO = "1";
      }),
      /not an allowlisted flag/,
    );
    assert.throws(
      bad((c) => {
        c.flags.READ_AUTHZ_MODE = "off";
      }),
      /flags.READ_AUTHZ_MODE: invalid value/,
    );
    assert.throws(
      bad((c) => {
        c.commands = ["rm -rf /"];
      }),
      /commands: not allowed/,
    );
    assert.throws(
      bad((c) => {
        c.environment = "production";
      }),
      /environment/,
    );
    assert.throws(
      bad((c) => {
        c.attestations = { "d1-migrations": "x.json" };
      }),
      /not an attestation gate/,
    );
    assert.throws(
      bad((c) => {
        c.oauth.protectedResourceMetadata = "../../etc/passwd";
      }),
      /inside the repository/,
    );
  });

  it("rejects real-looking hosts in a synthetic config", () => {
    const c = fixture();
    c.hostnames.mcp = "mcp.flightdeck.dev";
    assert.throws(() => checkConfig(c, manifest), /reserved test domains/);
  });

  it("rejects secret keys and values without echoing them", () => {
    const c = fixture();
    c.description = `token ${TOKEN}`;
    c.flags.API_TOKEN = "abc";
    try {
      checkConfig(c, manifest);
      assert.fail("expected rejection");
    } catch (error) {
      assert.match(error.message, /secret-like/);
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
    }
  });

  it("reads only allowlisted, non-secret FLIGHTDECK_PREFLIGHT_* variables", () => {
    const config = configFromEnv({
      FLIGHTDECK_PREFLIGHT_MCP_AUD: "synthetic-mcp",
      FLIGHTDECK_PREFLIGHT_ENVIRONMENT: "synthetic",
      OTHER: "ignored",
    });
    assert.deepEqual(config, { access: { mcpAud: "synthetic-mcp" }, environment: "synthetic" });
    assert.throws(
      () => configFromEnv({ FLIGHTDECK_PREFLIGHT_API_TOKEN: TOKEN }),
      /secrets are never accepted/,
    );
    assert.throws(() => configFromEnv({ FLIGHTDECK_PREFLIGHT_SHELL: "sh" }), /not a recognised/);
  });
});

describe("secret handling", () => {
  it("detects secret shapes but allows AUD hex where declared", () => {
    assert.ok(looksSecret(JWT));
    assert.ok(looksSecret(TOKEN));
    assert.ok(looksSecret("-----BEGIN PRIVATE KEY-----"));
    assert.ok(looksSecret("https://user:pw@db.example/x"));
    assert.ok(looksSecret("a".repeat(64)));
    assert.ok(!looksSecret("a".repeat(64), { allowHex: true }));
    assert.ok(!looksSecret("flightdeck.staging.example"));
    assert.deepEqual(
      findSecrets({ access: { mcpAud: "b".repeat(64) } }, { hexKeys: ["mcpAud"] }),
      [],
    );
    assert.deepEqual(findSecrets({ clientSecret: "x" }), ["$.clientSecret"]);
  });

  it("redacts tokens, bearer headers and secret-named env values", () => {
    const out = redact(
      `Authorization: Bearer ${TOKEN}\njwt=${JWT}\nAPI_TOKEN=hunter2hunter2\nkey`,
      {
        CLOUDFLARE_API_TOKEN: "plain-value-123",
      },
    );
    assert.doesNotMatch(out, new RegExp(TOKEN));
    assert.doesNotMatch(out, /eyJhbGci/);
    assert.doesNotMatch(out, /hunter2/);
    assert.equal(
      redact("value plain-value-123 here", { CLOUDFLARE_API_TOKEN: "plain-value-123" }),
      "value [redacted:env] here",
    );
  });

  it("never prints AUD values in CLI output, only fingerprints", () => {
    const aud = "c".repeat(64);
    const r = cli(["--format", "json", "--from-env"], {
      env: {
        ...process.env,
        FLIGHTDECK_PREFLIGHT_ENVIRONMENT: "synthetic",
        FLIGHTDECK_PREFLIGHT_DASHBOARD_AUD: aud,
        FLIGHTDECK_PREFLIGHT_MCP_AUD: "synthetic-mcp",
        FLIGHTDECK_PREFLIGHT_ACCESS_TEAM_DOMAIN: "team.example",
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(aud));
    assert.match(r.stdout, /fp:[0-9a-f]{8}/);
  });

  it("refuses a secret-bearing config file without printing the secret", () => {
    const root = makeRepo();
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({ ...fixture(), description: `Bearer ${TOKEN}` }));
    const r = cli(["--config", path]);
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOKEN));
  });

  it("refuses secret env variables without printing them", () => {
    const r = cli(["--from-env"], {
      env: { ...process.env, FLIGHTDECK_PREFLIGHT_API_TOKEN: TOKEN },
    });
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOKEN));
  });
});

describe("command safety", () => {
  it("accepts only allowlisted command ids", () => {
    assert.deepEqual(parseRunList("test,lint"), ["lint", "test"]);
    assert.equal(parseRunList("all").length, Object.keys(COMMANDS).length);
    for (const raw of [
      "lint;rm -rf /",
      "lint && id",
      "$(id)",
      "`id`",
      "lint|cat",
      "deploy",
      "",
      "../x",
    ]) {
      assert.throws(() => parseRunList(raw), /--run/, raw);
    }
  });

  it("never deploys and never uses a shell", () => {
    for (const [id, spec] of Object.entries(COMMANDS)) {
      if (spec.argv.includes("deploy")) assert.ok(spec.argv.includes("--dry-run"), id);
      assert.ok(!spec.argv.some((a) => /[;&|`$<>]/.test(a.replace("{out}", ""))), id);
      assert.ok(!spec.argv.some((a) => /migrations apply|--remote|publish|secret/.test(a)), id);
    }
  });

  it("spawns fixed argv with shell:false and a credential-free env", () => {
    const calls = [];
    const fakeSpawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: `ok Bearer ${TOKEN}`, stderr: "" };
    };
    const root = makeRepo({ "examples/lifecycle-fixtures/cli.mjs": "" });
    const outDir = join(root, "out");
    const saved = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "cf-secret-value-1";
    try {
      const results = runCommands(["lint", "fixtures-validate", "wrangler-dry-run-mcp"], {
        root,
        outDir,
        spawn: fakeSpawn,
      });
      assert.equal(results.lint.status, "passed");
    } finally {
      if (saved === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = saved;
    }
    for (const call of calls) {
      assert.equal(call.opts.shell, false);
      assert.equal(call.opts.env.CLOUDFLARE_API_TOKEN, "");
      assert.ok(!Object.values(call.opts.env).includes("cf-secret-value-1"));
    }
    const wrangler = calls.find((c) => c.args.includes("--dry-run"));
    assert.ok(wrangler.opts.env.XDG_CONFIG_HOME, "wrangler gets an isolated config home");
    for (const log of readdirSync(join(outDir, "logs"))) {
      assert.doesNotMatch(readFileSync(join(outDir, "logs", log), "utf8"), new RegExp(TOKEN));
    }
  });

  it("reports a missing command target instead of running it", () => {
    const root = makeRepo({ "apps/lifecycle-mcp/test": null });
    const r = runCommands(["mcp-acceptance"], {
      root,
      outDir: join(root, "out"),
      spawn: () => assert.fail(),
    });
    assert.equal(r["mcp-acceptance"].status, "missing");
  });

  it("childEnv drops secret-named and unlisted variables", () => {
    const env = childEnv({
      PATH: "/bin",
      GITHUB_TOKEN: "x",
      NODE_OPTIONS: "--require evil",
      HOME: "/h",
    });
    assert.equal(env.PATH, "/bin");
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
  });

  it("refuses remote/production flags and unknown options", () => {
    for (const flag of ["--remote", "--production", "--deploy", "--live=1"]) {
      const r = cli([flag]);
      assert.equal(r.status, 2, flag);
      assert.match(r.stderr, /not implemented|local-only/);
    }
    assert.equal(cli(["--run", "lint;id"]).status, 2);
    assert.equal(cli(["--surprise"]).status, 2);
  });
});

describe("paths", () => {
  it("keeps evidence inside the repository", () => {
    const root = makeRepo();
    assert.ok(resolveInside(root, "evidence/a.json"));
    for (const bad of ["../a.json", "/etc/passwd", "a/../../b", "a/$(id).json", "a;b", "", "./a"]) {
      assert.equal(resolveInside(root, bad), null, bad);
    }
  });
});

describe("no remote calls", () => {
  it("source imports no network modules and never calls fetch", () => {
    const dir = join(REPO, "scripts/lifecycle-preflight/lib");
    const sources = [
      join(REPO, "scripts/lifecycle-preflight.mjs"),
      ...readdirSync(dir).map((f) => join(dir, f)),
    ];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /from "node:(http|https|http2|net|tls|dgram|dns)"/, file);
      assert.doesNotMatch(text, /\bfetch\(|WebSocket|XMLHttpRequest/, file);
    }
  });

  it("a full run with the synthetic config opens no sockets", () => {
    const guard = join(makeRepo(), "guard.mjs");
    writeFileSync(
      guard,
      `import net from "node:net"; import dns from "node:dns"; import { writeSync } from "node:fs";
const trip = (what) => () => { writeSync(2, "REMOTE_CALL:" + what + "\\n"); process.exit(97); };
net.Socket.prototype.connect = trip("net.connect");
dns.lookup = trip("dns.lookup");
globalThis.fetch = trip("fetch");\n`,
    );
    const r = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--import",
        guard,
        CLI,
        "--config",
        FIXTURE_CONFIG,
        "--format",
        "json",
      ],
      { encoding: "utf8", cwd: REPO },
    );
    assert.doesNotMatch(r.stderr, /REMOTE_CALL/);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.remoteCalls, "none");
    assert.equal(report.verdicts["production-safe"].status, "blocked");
  });
});

describe("schema and JSONC helpers", () => {
  it("parses wrangler-style JSONC without touching strings", () => {
    const value = parseJsonc('{ // c\n "a": "x // not a comment, }", /* b */ "b": [1, 2,], }');
    assert.deepEqual(value, { a: "x // not a comment, }", b: [1, 2] });
  });

  it("validator reports paths, not values", () => {
    const errors = validate(
      { type: "object", properties: { a: { type: "string", pattern: "^x$" } } },
      { a: TOKEN },
    );
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0], new RegExp(TOKEN));
  });
});
