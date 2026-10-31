import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SKILL_URL } from "../src/apps";
import { HELP, main } from "../src/cli";
import type { Deps } from "../src/deps";

const URL_ = "https://flightdeck.example.com";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const BYTES = new Uint8Array(32).fill(7);
const KEY = Buffer.from(BYTES).toString("base64url");
const DIGEST = createHash("sha256").update(KEY).digest("hex");
const NOW = Date.UTC(2026, 9, 31);
const DAY = 24 * 60 * 60 * 1000;

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Setup = {
  env?: Record<string, string>;
  response?: Response;
  exec?: Deps["exec"];
  open?: () => Promise<void>;
  write?: () => Promise<void>;
};

function setup(opts: Setup = {}) {
  let out = "";
  let err = "";
  const file = {
    write: vi.fn(opts.write ?? (async () => {})),
    close: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
  };
  const deps = {
    env: { FLIGHTDECK_URL: URL_, ...opts.env },
    fetch: vi.fn(async () => opts.response ?? reply(200, {})),
    exec: vi.fn(opts.exec ?? (async () => `${JWT}\n`)),
    stdout: (t: string) => {
      out += t;
    },
    stderr: (t: string) => {
      err += t;
    },
    openSecretFile: vi.fn(async () => {
      await opts.open?.();
      return file;
    }),
    randomBytes: vi.fn(() => BYTES),
    now: () => NOW,
  } satisfies Deps;
  const call = (i = 0) => {
    const [url, init] = deps.fetch.mock.calls[i] as unknown as [string, RequestInit];
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    return { url, init, headers: init.headers as Record<string, string>, body };
  };
  return { deps, file, call, out: () => out, err: () => err };
}

const SERVICE_TOKEN = {
  FLIGHTDECK_ACCESS_CLIENT_ID: "id.access",
  FLIGHTDECK_ACCESS_CLIENT_SECRET: "s3cret",
};

describe("help", () => {
  it("prints help with no subcommand (the future installer entry point) and for --help", async () => {
    for (const argv of [[], ["apps", "--help"], ["-h"]]) {
      const t = setup();
      expect(await main(argv, t.deps)).toBe(0);
      expect(t.out()).toBe(HELP);
    }
  });

  it("rejects unknown commands and options", async () => {
    for (const argv of [["nope"], ["apps"], ["apps", "add"], ["apps", "list", "--bogus"]]) {
      const t = setup();
      expect(await main(argv, t.deps)).toBe(1);
      expect(t.err()).not.toBe("");
      expect(t.deps.fetch).not.toHaveBeenCalled();
    }
  });
});

describe("auth and URL", () => {
  it("prefers an Access service token from the environment", async () => {
    const t = setup({ env: SERVICE_TOKEN, response: reply(200, { apps: [] }) });
    expect(await main(["apps", "list"], t.deps)).toBe(0);
    expect(t.deps.exec).not.toHaveBeenCalled();
    expect(t.call().headers).toMatchObject({
      "CF-Access-Client-Id": "id.access",
      "CF-Access-Client-Secret": "s3cret",
    });
    expect(t.call().init.redirect).toBe("manual");
  });

  it("falls back to cloudflared access token for --url", async () => {
    const t = setup({ response: reply(200, { apps: [] }) });
    expect(await main(["apps", "list", "--url", "https://other.example.com/"], t.deps)).toBe(0);
    expect(t.deps.exec).toHaveBeenCalledWith("cloudflared", [
      "access",
      "token",
      "--app",
      "https://other.example.com",
    ]);
    expect(t.call().url).toBe("https://other.example.com/api/apps");
    expect(t.call().headers["cf-access-token"]).toBe(JWT);
  });

  it("explains both options when no credentials are available", async () => {
    for (const exec of [
      async () => {
        throw new Error("ENOENT");
      },
      async () => "Unable to find token for provided application.",
    ]) {
      const t = setup({ exec });
      expect(await main(["apps", "list"], t.deps)).toBe(1);
      expect(t.err()).toContain("FLIGHTDECK_ACCESS_CLIENT_ID");
      expect(t.err()).toContain(`cloudflared access login ${URL_}`);
      expect(t.deps.fetch).not.toHaveBeenCalled();
    }
  });

  it("requires a URL, https, and both service token halves", async () => {
    const cases: [string[], Record<string, string>][] = [
      [["apps", "list"], { FLIGHTDECK_URL: "" }],
      [["apps", "list", "--url", "http://flightdeck.example.com"], {}],
      [["apps", "list"], { FLIGHTDECK_ACCESS_CLIENT_ID: "id.access" }],
    ];
    for (const [argv, env] of cases) {
      const t = setup({ env });
      expect(await main(argv, t.deps)).toBe(1);
      expect(t.deps.fetch).not.toHaveBeenCalled();
    }
    const local = setup({ response: reply(200, { apps: [] }) });
    expect(await main(["apps", "list", "--url", "http://localhost:8787"], local.deps)).toBe(0);
  });

  it("reports Access login redirects and API errors", async () => {
    const redirect = setup({ response: new Response(null, { status: 302 }) });
    expect(await main(["apps", "list"], redirect.deps)).toBe(1);
    expect(redirect.err()).toContain("Cloudflare Access rejected");
    const denied = setup({ response: reply(401, { error: "Unauthorized" }) });
    expect(await main(["apps", "list"], denied.deps)).toBe(1);
    expect(denied.err()).toContain("401 Unauthorized");
  });
});

describe("apps", () => {
  const app = { id: "app_kanbanger_staging", name: "Kanbanger (staging)", created_at: NOW };
  const binding = {
    binding: "FLIGHTDECK",
    service: "flightdeck",
    entrypoint: "Ingest",
    props: { appId: app.id },
  };

  it("lists apps", async () => {
    const t = setup({ response: reply(200, { apps: [app] }) });
    expect(await main(["apps", "list"], t.deps)).toBe(0);
    expect(t.out()).toBe("app_kanbanger_staging  Kanbanger (staging)\n");
  });

  it("adds an app and prints the wrangler services block and next steps", async () => {
    const t = setup({ response: reply(201, { app, binding }) });
    expect(await main(["apps", "add", "Kanbanger", "--stage", "staging"], t.deps)).toBe(0);
    expect(t.call()).toMatchObject({
      url: `${URL_}/api/apps`,
      init: { method: "POST" },
      body: { name: "Kanbanger", stage: "staging" },
    });
    expect(t.out()).toContain("Registered Kanbanger (staging) as app_kanbanger_staging.");
    expect(t.out()).toContain(JSON.stringify({ services: [binding] }, null, 2));
    expect(t.out()).toContain("withFlightdeck");
    expect(t.out()).toContain(SKILL_URL);
  });

  it("prints machine output with --json, including idempotent re-adds", async () => {
    const t = setup({ response: reply(200, { app, binding }) });
    expect(await main(["apps", "add", "Kanbanger", "--stage", "staging", "--json"], t.deps)).toBe(
      0,
    );
    expect(JSON.parse(t.out())).toEqual({ created: false, app, binding });
  });
});

describe("apps key", () => {
  it("sends only the digest and prints the raw key once to stdout", async () => {
    const t = setup({ response: reply(201, {}) });
    expect(await main(["apps", "key", "app_bob"], t.deps)).toBe(0);
    expect(t.call()).toMatchObject({
      url: `${URL_}/api/apps/app_bob/server-keys`,
      body: { token_hash: DIGEST, expires_at: NOW + 90 * DAY },
    });
    expect(t.call().init.body).not.toContain(KEY);
    expect(t.out()).toBe(`${KEY}\n`);
    expect(t.err()).not.toContain(KEY);
    expect(t.err()).toContain("secret");
  });

  it("writes the key to a 0600 file with --out and never prints it", async () => {
    const t = setup({ response: reply(201, {}) });
    expect(await main(["apps", "key", "app_bob", "--days", "30", "--out", "key.txt"], t.deps)).toBe(
      0,
    );
    expect(t.call().body.expires_at).toBe(NOW + 30 * DAY);
    expect(t.deps.openSecretFile).toHaveBeenCalledWith("key.txt");
    expect(t.file.write).toHaveBeenCalledWith(`${KEY}\n`);
    expect(t.file.close).toHaveBeenCalled();
    expect(t.file.discard).not.toHaveBeenCalled();
    expect(t.out()).toBe("");
    expect(t.err()).not.toContain(KEY);
    expect(t.err()).toContain("key.txt");
  });

  it("does not reveal a key the server did not accept", async () => {
    const t = setup({ response: reply(404, { error: "Unknown app" }) });
    expect(await main(["apps", "key", "app_missing"], t.deps)).toBe(1);
    expect(t.out() + t.err()).not.toContain(KEY);
  });

  it("opens --out before registering, so an unusable path never creates a key", async () => {
    const t = setup({
      response: reply(201, {}),
      open: async () => {
        throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
      },
    });
    expect(await main(["apps", "key", "app_bob", "--out", "key.txt"], t.deps)).toBe(1);
    expect(t.deps.fetch).not.toHaveBeenCalled();
    expect(t.err()).toContain("key.txt");
    expect(t.err()).not.toContain(KEY);
  });

  it("removes the --out file when the server rejects the key", async () => {
    const t = setup({ response: reply(404, { error: "Unknown app" }) });
    expect(await main(["apps", "key", "app_missing", "--out", "key.txt"], t.deps)).toBe(1);
    expect(t.file.write).not.toHaveBeenCalled();
    expect(t.file.discard).toHaveBeenCalled();
  });

  it("tells you how to revoke a registered key it could not write", async () => {
    const t = setup({
      response: reply(201, {}),
      write: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });
    expect(await main(["apps", "key", "app_bob", "--out", "key.txt"], t.deps)).toBe(1);
    expect(t.err()).toContain(`create-flightdeck apps revoke-key app_bob ${DIGEST}`);
    expect(t.err()).toContain("ENOSPC");
    expect(t.out() + t.err()).not.toContain(KEY);
    expect(t.file.discard).toHaveBeenCalled();
  });

  it("validates --days", async () => {
    for (const days of ["0", "401", "1.5", "soon"]) {
      const t = setup({ env: SERVICE_TOKEN });
      expect(await main(["apps", "key", "app_bob", "--days", days], t.deps)).toBe(1);
      expect(t.deps.fetch).not.toHaveBeenCalled();
    }
  });

  it("revokes a key by digest", async () => {
    const t = setup({ response: new Response(null, { status: 204 }) });
    expect(await main(["apps", "revoke-key", "app_bob", DIGEST], t.deps)).toBe(0);
    expect(t.call()).toMatchObject({
      url: `${URL_}/api/apps/app_bob/server-keys/${DIGEST}`,
      init: { method: "DELETE" },
    });
    const bad = setup();
    expect(await main(["apps", "revoke-key", "app_bob", "nothex"], bad.deps)).toBe(1);
  });
});
