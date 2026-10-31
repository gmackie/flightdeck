import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../src/api";
import { authorizeApp, authorizeLifecycleRead } from "../src/api/authorization";
import {
  classifyDimension,
  type LifecycleAggregate,
  projectLifecycleAggregates,
} from "../src/api/lifecycle-policy";

const TEAM = "https://policy.cloudflareaccess.com";
const AUD = "dashboard-only";
const configured = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, FLIGHTDECK_DEV: "0" };
const person = { sub: "policy-person", serviceToken: false };
let keys: ReturnType<typeof createLocalJWKSet>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "policy", alg: "RS256" }],
  });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO apps (id, name, access_aud) VALUES ('app_policy_a', 'Policy A', 'another-app-aud'), ('app_policy_b', 'Policy B', NULL), ('app_policy_c', 'Policy C', NULL)",
    ),
    env.DB.prepare("INSERT INTO authz_projects (id) VALUES ('project_policy')"),
    env.DB.prepare(
      "INSERT INTO authz_app_projects (app_id, project_id) VALUES ('app_policy_a', 'project_policy'), ('app_policy_b', 'project_policy')",
    ),
  ]);
});

const sign = (subject = person.sub, extra: Record<string, unknown> = {}, audience = AUD) =>
  new SignJWT({ email: "synthetic@example.test", ...extra })
    .setProtectedHeader({ alg: "RS256", kid: "policy" })
    .setSubject(subject)
    .setIssuer(TEAM)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

const call = (
  path: string,
  token?: string,
  options: Partial<Env> = {},
  headers: Record<string, string> = {},
) =>
  apiRoutes(
    new Request(`https://flightdeck.test/api/apps/${path}`, {
      headers: { ...headers, ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}) },
    }),
    { ...configured, ...options },
    createExecutionContext(),
    { keys },
  );

async function grant(
  id: string,
  subject: string,
  role = "reader",
  scope = "app_policy_a",
  kind = "person",
  project = false,
) {
  await env.DB.prepare(`INSERT INTO authz_grants
    (id, principal_kind, principal_subject, role, app_id, project_id)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, kind, subject, role, project ? null : scope, project ? scope : null)
    .run();
}

it("denies cross-app, forged and unknown app IDs with identical non-enumerating responses", async () => {
  await grant("scope-reader", person.sub);
  const jwt = await sign();
  expect((await call("app_policy_a/lifecycle/policy", jwt)).status).toBe(200);
  for (const app of ["app_policy_b", "app_policy_c", "app_forged"]) {
    const res = await call(
      `${app}/lifecycle/policy?app_id=app_policy_a`,
      jwt,
      {},
      { "X-App-Id": "app_policy_a" },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  }
  expect((await call("app_policy_a/lifecycle/projection?dimensions=workflow", jwt)).status).toBe(
    403,
  );
});

it("uses only the existing dashboard Access JWT, never the ingestion app audience", async () => {
  await grant("single-jwt", "single-jwt");
  const res = await call("app_policy_a/lifecycle/policy", await sign("single-jwt"));
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(
    (await call("app_policy_a/lifecycle/policy", await sign("single-jwt", {}, "another-app-aud")))
      .status,
  ).toBe(401);
  expect((await call("app_policy_a/lifecycle/policy")).status).toBe(401);
  expect((await call("app_policy_a/lifecycle/policy", "forged.jwt")).status).toBe(401);
  expect(
    (
      await call(
        "app_policy_a/lifecycle/policy",
        undefined,
        {},
        { Authorization: "Bearer ingest-write-secret" },
      )
    ).status,
  ).toBe(401);
  await env.DB.prepare(
    "INSERT INTO server_ingest_keys (token_hash, app_id, expires_at) VALUES (?, 'app_policy_a', ?)",
  )
    .bind("a".repeat(64), Date.now() + 60_000)
    .run();
  expect((await call("app_policy_a/lifecycle/policy", await sign("ungranted-writer"))).status).toBe(
    403,
  );
});

it("checks revocation and expiry on every request without a grant cache", async () => {
  await grant("revocable", "revocable");
  const jwt = await sign("revocable");
  expect((await call("app_policy_a/lifecycle/policy", jwt)).status).toBe(200);
  await env.DB.prepare("UPDATE authz_grants SET revoked_at = ? WHERE id = 'revocable'")
    .bind(Date.now())
    .run();
  expect((await call("app_policy_a/lifecycle/policy", jwt)).status).toBe(403);
  await env.DB.prepare(
    "UPDATE authz_grants SET revoked_at = NULL, created_at = 1, expires_at = 2 WHERE id = 'revocable'",
  ).run();
  expect((await call("app_policy_a/lifecycle/policy", jwt)).status).toBe(403);
});

it("inherits project grants only through explicit membership and keeps admins scoped", async () => {
  await grant("project-admin", "project-admin", "admin", "project_policy", "person", true);
  const jwt = await sign("project-admin");
  for (const app of ["app_policy_a", "app_policy_b"]) {
    expect((await call(`${app}/lifecycle/projection?dimensions=workflow`, jwt)).status).toBe(200);
  }
  expect((await call("app_policy_c/lifecycle/policy", jwt)).status).toBe(403);
  await env.DB.prepare("DELETE FROM authz_app_projects WHERE app_id = 'app_policy_b'").run();
  expect((await call("app_policy_b/lifecycle/policy", jwt)).status).toBe(403);
});

it("separates service/person identity and caps services at app-scoped reader", async () => {
  await grant("same-person", "dual-identity", "admin");
  const jwt = await sign("dual-identity", { common_name: "dual-identity" });
  expect((await call("app_policy_a/lifecycle/policy", jwt)).status).toBe(403);
  await grant("same-service", "dual-identity", "reader", "app_policy_a", "service");
  expect((await call("app_policy_a/lifecycle/policy", jwt)).status).toBe(200);
  expect((await call("app_policy_b/lifecycle/policy", jwt)).status).toBe(403);
  expect((await call("app_policy_a/lifecycle/projection?dimensions=workflow", jwt)).status).toBe(
    403,
  );
  expect(
    (await authorizeApp(
      configured,
      { sub: "dual-identity", serviceToken: true },
      "app_policy_a",
      "policy:manage",
    )) instanceof Response,
  ).toBe(true);
  await expect(grant("service-owner", "svc", "owner", "app_policy_a", "service")).rejects.toThrow();
  await expect(
    grant("service-project", "svc", "reader", "project_policy", "service", true),
  ).rejects.toThrow();
});

it("fails closed in production, local dev, missing policy storage and unknown lifecycle routes", async () => {
  await grant("fail-closed", "fail-closed");
  const jwt = await sign("fail-closed");
  for (const FLIGHTDECK_DEV of ["0", "1"]) {
    expect(
      (await call("app_policy_a/lifecycle/policy", jwt, { ACCESS_AUD: "", FLIGHTDECK_DEV })).status,
    ).toBe(503);
  }
  const unavailable = {
    prepare: () => {
      throw new Error("private-subject@example.test");
    },
  } as unknown as D1Database;
  const log = vi.spyOn(console, "error");
  const warn = vi.spyOn(console, "warn");
  expect((await call("app_policy_a/lifecycle/policy", jwt, { DB: unavailable })).status).toBe(503);
  expect(log).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  log.mockRestore();
  warn.mockRestore();
  expect(
    (await call("app_policy_a/lifecycle/future-sensitive-read", await sign("no-grant"))).status,
  ).toBe(403);
  expect((await call("app_policy_a/lifecycle/future-sensitive-read", jwt)).status).toBe(404);
});

describe("legacy rollout", () => {
  it("preserves deployed reads in legacy mode and opts live/socket/trends into grants together", async () => {
    const jwt = await sign("legacy-reader");
    for (const route of ["live", "live/ws", "trends"]) {
      // No websocket upgrade: reaching the existing handler yields 426.
      const expected = route === "live/ws" ? 426 : 200;
      for (const READ_AUTHZ_MODE of ["legacy", ""]) {
        expect((await call(`app_policy_a/${route}`, jwt, { READ_AUTHZ_MODE })).status).toBe(
          expected,
        );
      }
      expect(
        (await call(`app_policy_a/${route}`, jwt, { READ_AUTHZ_MODE: "enforce" })).status,
      ).toBe(403);
      expect((await call(`app_policy_a/${route}`, jwt, { READ_AUTHZ_MODE: "typo" })).status).toBe(
        503,
      );
    }
    await grant("legacy-reader", "legacy-reader");
    expect((await call("app_policy_a/live/ws", jwt, { READ_AUTHZ_MODE: "enforce" })).status).toBe(
      426,
    );
    expect((await call("app_policy_a/trends", jwt, { READ_AUTHZ_MODE: "enforce" })).status).toBe(
      200,
    );
    expect((await call("app_policy_b/live", jwt, { READ_AUTHZ_MODE: "enforce" })).status).toBe(403);
    // Legacy compatibility never applies to lifecycle.
    expect(
      (await call("app_policy_b/lifecycle/policy", jwt, { READ_AUTHZ_MODE: "legacy" })).status,
    ).toBe(403);
  });
});

it("allows projection only for an analyst and rejects identifiers, arbitrary values and schema drift", async () => {
  await grant("privacy-analyst", "privacy-analyst", "analyst");
  const jwt = await sign("privacy-analyst");
  const res = await call("app_policy_a/lifecycle/projection?dimensions=workflow,phase", jwt);
  expect(await res.json()).toEqual({
    app_id: "app_policy_a",
    dimensions: ["workflow", "phase"],
    policy_version: 1,
  });
  for (const query of [
    "",
    "dimensions=email",
    "dimensions=hashed_user_id",
    "dimensions=workflow,workflow",
    "dimensions=workflow&app_id=app_policy_b",
  ]) {
    expect((await call(`app_policy_a/lifecycle/projection?${query}`, jwt)).status).toBe(400);
  }
  const scope = await authorizeLifecycleRead(
    configured,
    { sub: "privacy-analyst", serviceToken: false },
    "app_policy_a",
    "process:read",
  );
  if (scope instanceof Response) throw new Error("Expected authorized scope");
  const row: LifecycleAggregate = {
    app_id: "app_policy_a",
    dimensions: { workflow: "deployment" },
    count: 14,
    cohort_size: 5,
  };
  expect(projectLifecycleAggregates(scope, ["workflow"], [row])).toEqual([
    { dimensions: { workflow: "deployment" }, count: 10 },
  ]);
  // Many events from a single subject are still a small cohort.
  expect(
    projectLifecycleAggregates(scope, ["workflow"], [{ ...row, count: 100, cohort_size: 4 }]),
  ).toEqual([]);
  expect(
    projectLifecycleAggregates(scope, ["workflow"], [{ ...row, count: 0, cohort_size: 0 }]),
  ).toEqual([]);
  for (const bad of [
    { ...row, app_id: "app_policy_b" },
    { ...row, dimensions: { workflow: "synthetic@example.test" } },
    { ...row, dimensions: { workflow: "deployment", email: "synthetic@example.test" } },
    { ...row, count: Number.NaN },
    { ...row, count: -1 },
    { ...row, cohort_size: 1.5 },
    { ...row, cohort_size: 100 },
  ])
    expect(() => projectLifecycleAggregates(scope, ["workflow"], [bad])).toThrow(
      "Invalid aggregate",
    );
  expect(() => projectLifecycleAggregates(scope, ["workflow"], [row, row])).toThrow(
    "Duplicate aggregate",
  );
  expect(() => projectLifecycleAggregates(scope, ["email"], [row])).toThrow("Invalid projection");
  await grant("privacy-reader", "privacy-reader");
  const read = await authorizeLifecycleRead(
    configured,
    { sub: "privacy-reader", serviceToken: false },
    "app_policy_a",
  );
  if (read instanceof Response) throw new Error("Expected reader scope");
  expect(() => projectLifecycleAggregates(read, ["workflow"], [row])).toThrow(
    "Process read authorization required",
  );
  expect(() =>
    projectLifecycleAggregates(
      { appId: "app_policy_a", capability: "process:read" } as typeof scope,
      ["workflow"],
      [row],
    ),
  ).toThrow("Process read authorization required");
  for (const name of [
    "person_id",
    "email",
    "session_id",
    "candidate_id",
    "trace_id",
    "hashed_user_id",
    "__proto__",
  ])
    expect(classifyDimension(name)).toBe("restricted");
});
