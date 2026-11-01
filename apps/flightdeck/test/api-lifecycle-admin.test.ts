import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEV_PRINCIPAL } from "../src/api/auth";
import { apiRoutes } from "../src/api/index";
import { isLifecycleAdmin } from "../src/api/lifecycle-admin";
import { sinks } from "../src/sinks";
import { DEPLOY_PROCESS, registerDeploy } from "./lifecycle-process-fixtures";

// The test Worker runs with FLIGHTDECK_DEV=1 and no Access config, so the dev principal
// (dev@localhost) applies. It is a lifecycle admin only when listed in LIFECYCLE_ADMINS.
const ADMIN_ENV = { ...env, LIFECYCLE_ADMINS: "ops@example.com, DEV@localhost" } as Env;
const APP = "app_la_main";

const call = (path: string, init: RequestInit & { json?: unknown } = {}, admin = true) =>
  apiRoutes(
    new Request(`https://flightdeck.test${path}`, {
      ...init,
      ...(init.json !== undefined
        ? {
            body: JSON.stringify(init.json),
            headers: { "Content-Type": "application/json" },
            method: init.method ?? "POST",
          }
        : {}),
    }),
    admin ? ADMIN_ENV : env,
    createExecutionContext(),
  );

const sha256 = async (s: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

beforeAll(async () => {
  for (const id of [APP, "app_la_other"]) {
    await env.DB.prepare("INSERT INTO apps (id, name) VALUES (?, ?)").bind(id, id).run();
  }
});
afterEach(() => vi.restoreAllMocks());

describe("isLifecycleAdmin", () => {
  it("matches listed emails case-insensitively and fails closed when the list is empty", () => {
    const user = { sub: "u-1", email: "Ops@Example.com", serviceToken: false };
    expect(isLifecycleAdmin(ADMIN_ENV, user)).toBe(true);
    expect(isLifecycleAdmin({ ...env, LIFECYCLE_ADMINS: "" } as Env, user)).toBe(false);
    expect(isLifecycleAdmin({ ...env, LIFECYCLE_ADMINS: " , " } as Env, user)).toBe(false);
    expect(isLifecycleAdmin(ADMIN_ENV, { ...user, email: "eve@example.com" })).toBe(false);
  });

  it("matches service tokens by client id, never a user's sub", () => {
    const listed = { ...env, LIFECYCLE_ADMINS: "abc.access" } as Env;
    expect(isLifecycleAdmin(listed, { sub: "abc.access", serviceToken: true })).toBe(true);
    expect(isLifecycleAdmin(listed, { sub: "abc.access", serviceToken: false })).toBe(false);
  });

  it("does not make the dev principal an admin by default", () => {
    expect(isLifecycleAdmin(env, DEV_PRINCIPAL)).toBe(false);
  });
});

describe("/api/apps/:id/capabilities/lifecycle.write", () => {
  const path = `/api/apps/${APP}/capabilities/lifecycle.write`;

  it("refuses principals outside LIFECYCLE_ADMINS", async () => {
    expect((await call(path, { method: "PUT" }, false)).status).toBe(403);
    expect((await call(path, { method: "DELETE" }, false)).status).toBe(403);
    const row = await env.DB.prepare("SELECT 1 FROM app_capabilities WHERE app_id = ?")
      .bind(APP)
      .first();
    expect(row).toBeNull();
  });

  it("grants idempotently, revokes, and audits who did it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const grant = await call(path, { method: "PUT" });
    expect(grant.status).toBe(201);
    expect(await grant.json()).toEqual({
      app_id: APP,
      capability: "lifecycle.write",
      granted: true,
    });
    expect((await call(path, { method: "PUT" })).status).toBe(200);
    // The grant is live for the service binding at once.
    await registerDeploy(APP);
    expect(await exports.Ingest({ props: { appId: APP } }).registerProcess(DEPLOY_PROCESS)).toEqual(
      {
        created: false,
      },
    );
    expect((await call(path, { method: "DELETE" })).status).toBe(204);
    expect((await call(path, { method: "DELETE" })).status).toBe(404);
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(lines).toEqual([
      {
        event: "flightdeck.lifecycle_admin",
        action: "grant",
        by: "dev@localhost",
        app_id: APP,
        capability: "lifecycle.write",
      },
      {
        event: "flightdeck.lifecycle_admin",
        action: "revoke",
        by: "dev@localhost",
        app_id: APP,
        capability: "lifecycle.write",
      },
    ]);
  });

  it("checks the app and the method", async () => {
    expect(
      (await call("/api/apps/app_la_missing/capabilities/lifecycle.write", { method: "PUT" }))
        .status,
    ).toBe(404);
    expect((await call(path)).status).toBe(405);
    expect(
      (await call(`/api/apps/${APP}/capabilities/events.write`, { method: "PUT" })).status,
    ).toBe(404);
  });
});

describe("lifecycle-scoped keys", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const keyBody = async (raw: string, scopes?: string[]) => ({
    token_hash: await sha256(raw),
    expires_at: Date.now() + 30 * DAY,
    ...(scopes ? { scopes } : {}),
  });
  const keys = (app = APP) => `/api/apps/${app}/server-keys`;

  it("mints lifecycle keys only for lifecycle admins", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const body = await keyBody("s".repeat(43), ["lifecycle.write"]);
    expect((await call(keys(), { json: body }, false)).status).toBe(403);
    const created = await call(keys(), { json: body });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      key: {
        app_id: APP,
        token_hash: body.token_hash,
        expires_at: body.expires_at,
        scopes: ["lifecycle.write"],
      },
    });
    // events.write alone stays available to any Access principal, as before.
    expect(
      (await call(keys(), { json: await keyBody("t".repeat(43), ["events.write"]) }, false)).status,
    ).toBe(201);
    for (const scopes of [[], ["lifecycle.write", "lifecycle.write"], ["admin"]]) {
      expect((await call(keys(), { json: await keyBody("w".repeat(43), scopes) })).status).toBe(
        400,
      );
    }
  });

  it("sets scopes by digest for admins only, and the key works on the lifecycle endpoint", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const send = vi.spyOn(sinks, "lifecycle").mockResolvedValue();
    const raw = "v".repeat(43);
    const body = await keyBody(raw);
    expect((await call(keys(), { json: body }, false)).status).toBe(201);
    const scopesPath = `${keys()}/${body.token_hash}/scopes`;
    const set = (scopes: unknown, admin = true) =>
      call(scopesPath, { method: "PUT", json: { scopes } }, admin);
    expect((await set(["lifecycle.write"], false)).status).toBe(403);
    expect((await set(["events.write", "events.write"])).status).toBe(400);
    expect(
      (
        await call(`${keys("app_la_other")}/${body.token_hash}/scopes`, {
          method: "PUT",
          json: { scopes: ["lifecycle.write"] },
        })
      ).status,
    ).toBe(404);
    const ok = await set(["lifecycle.write", "events.write"]);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      key: {
        app_id: APP,
        token_hash: body.token_hash,
        scopes: ["events.write", "lifecycle.write"],
      },
    });

    await call(`/api/apps/${APP}/capabilities/lifecycle.write`, { method: "PUT" });
    await registerDeploy(APP);
    const res = await exports.default.fetch("https://flightdeck.test/v1/lifecycle/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${raw}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            schemaVersion: 1,
            eventId: "evt_la_000001",
            processId: "deploy",
            processVersion: 1,
            type: "case.created",
            caseId: "deploy:la:1",
            occurredAt: Date.now() - 1_000,
            sourceSequence: 1,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
