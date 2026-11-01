import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { LifecycleEventInput } from "@flightdeckhq/schema";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { apiRoutes } from "../../src/api";
import { lifecycleIngest, processRegistration } from "../../src/ingest/lifecycle-http";
import { LifecycleProjector } from "../../src/lifecycle-projection/projector";
import { fixtureDefinitions } from "./fixture-adapter";

/**
 * End-to-end harness: producers go through the real `/v1/lifecycle/*` handlers with scoped keys,
 * the projector is drained explicitly (deterministic, instead of after-response work), and reads
 * go through the real `/api/*` dispatcher with signed Access JWTs and D1 grants.
 */

// biome-ignore lint/suspicious/noExplicitAny: test-only JSON access
export type Json = any;

const TEAM = "https://lifecycle-e2e.cloudflareaccess.com";
const AUD = "lifecycle-e2e-dashboard";
export const READ_ENV = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, FLIGHTDECK_DEV: "0" };

let signing: { privateKey: CryptoKey; keys: ReturnType<typeof createLocalJWKSet> } | undefined;
async function signer() {
  if (!signing) {
    const pair = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "e2e", alg: "RS256" };
    signing = { privateKey: pair.privateKey, keys: createLocalJWKSet({ keys: [jwk] }) };
  }
  return signing;
}

/** A person (`sub` + email) or a service token (`common_name`) Access assertion. */
export async function token(subject: string, service = false): Promise<string> {
  const { privateKey } = await signer();
  const claims = service ? { common_name: subject } : { email: "synthetic@example.test" };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "e2e" })
    .setSubject(service ? "" : subject)
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

let grants = 0;
export async function grant(
  subject: string,
  role: "reader" | "analyst" | "owner" | "admin",
  appId: string,
  kind: "person" | "service" = "person",
) {
  await env.DB.prepare(
    `INSERT INTO authz_grants (id, principal_kind, principal_subject, app_id, role)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(`grant_e2e_${++grants}`, kind, subject, appId, role)
    .run();
}

/** GET a dashboard API path as `subject` (null: no Access assertion at all). */
export async function read(path: string, jwt: string | null) {
  const { keys } = await signer();
  const res = await apiRoutes(
    new Request(`https://flightdeck.test${path}`, {
      headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {},
    }),
    READ_ENV,
    createExecutionContext(),
    { keys },
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Json };
}

const hash = async (s: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Registers an app with an operator-granted `lifecycle.write`, a scoped producer key and every
 * fixture process definition (through the registration endpoint). Operator steps are plain D1
 * statements, as in production today.
 */
export async function producerApp(appId: string): Promise<string> {
  const key = `k${crypto.randomUUID().replace(/-/g, "")}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO apps (id, name) VALUES (?, ?)").bind(appId, appId),
    env.DB.prepare(
      "INSERT INTO app_capabilities (app_id, capability) VALUES (?, 'lifecycle.write')",
    ).bind(appId),
    env.DB.prepare(
      `INSERT INTO server_ingest_keys (token_hash, app_id, expires_at, scopes)
       VALUES (?, ?, ?, 'lifecycle.write')`,
    ).bind(await hash(key), appId, Date.now() + 3_600_000),
  ]);
  for (const definition of fixtureDefinitions()) {
    const res = await processRegistration(post("/v1/lifecycle/processes", key, definition), env);
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`registering ${definition.processId}: ${res.status} ${await res.text()}`);
    }
  }
  return key;
}

const post = (path: string, key: string, body: unknown) =>
  new Request(`https://flightdeck.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * Sends events through `POST /v1/lifecycle/events` in producer-sized batches, in order. A batch
 * never repeats an event id (the contract rejects that); a redelivery goes in a later batch, as a
 * producer retry would.
 */
export async function deliver(key: string, events: readonly LifecycleEventInput[], size = 50) {
  const batches: LifecycleEventInput[][] = [[]];
  let ids = new Set<string>();
  for (const event of events) {
    let batch = batches.at(-1) as LifecycleEventInput[];
    if (batch.length >= size || ids.has(event.eventId)) {
      batch = [];
      batches.push(batch);
      ids = new Set();
    }
    batch.push(event);
    ids.add(event.eventId);
  }
  for (const [i, batch] of batches.entries()) {
    if (!batch.length) continue;
    const res = await lifecycleIngest(post("/v1/lifecycle/events", key, { events: batch }), env);
    if (res.status !== 200) throw new Error(`batch ${i}: ${res.status} ${await res.text()}`);
  }
  return batches.length;
}

/** Drains the app's projection queue to empty (or throws if it stops making progress). */
export async function project(appId: string, now: () => number = Date.now) {
  const projector = new LifecycleProjector(env.DB, { now });
  for (let round = 0; round < 1_000; round++) {
    const result = await projector.drain(appId, 200);
    if (result.remaining === 0) return;
    if (result.projected + result.removed === 0 && !result.rebuilt) {
      throw new Error(`projection stuck with ${result.remaining} queued cases`);
    }
  }
  throw new Error("projection did not converge");
}

/** The served read model of an app, as plain rows, for whole-model comparisons. */
export async function servedModel(appId: string) {
  const [cases, intervals, edges] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT case_id, process_key, process_version, status, outcome, current_stage,
         parent_case_id, started_at, ended_at, last_event_at, source_watermark
       FROM lifecycle_case_snapshots WHERE app_id = ? AND deleted_at IS NULL ORDER BY case_id`,
    ).bind(appId),
    env.DB.prepare(
      `SELECT case_id, seq, stage_key, state, entered_at, exited_at, outcome
       FROM lifecycle_stage_intervals WHERE app_id = ? ORDER BY case_id, seq`,
    ).bind(appId),
    env.DB.prepare(
      `SELECT from_case_id, relation, to_case_id FROM lifecycle_case_edges WHERE app_id = ?
       ORDER BY from_case_id, relation, to_case_id`,
    ).bind(appId),
  ]);
  return {
    cases: cases?.results ?? [],
    intervals: intervals?.results ?? [],
    edges: edges?.results ?? [],
  };
}

export type StageAttempt = { stage: string; entered: number; exited: number | null; state: string };

/**
 * Rejoins served interval segments into stage attempts (wall-clock, paused time included). One
 * attempt's segments are contiguous and alternate state (same-state runs are merged when
 * written), so a contiguous segment of the same stage in the same state starts a new attempt.
 */
export function attempts(intervals: readonly Json[]): Map<string, StageAttempt[]> {
  const byCase = new Map<string, StageAttempt[]>();
  for (const iv of intervals) {
    const list = byCase.get(iv.case_id) ?? [];
    byCase.set(iv.case_id, list);
    const last = list.at(-1);
    if (
      last &&
      last.stage === iv.stage_key &&
      last.exited === iv.entered_at &&
      last.state !== iv.state
    ) {
      last.exited = iv.exited_at;
      last.state = iv.state;
    } else {
      list.push({
        stage: iv.stage_key,
        entered: iv.entered_at,
        exited: iv.exited_at,
        state: iv.state,
      });
    }
  }
  return byCase;
}
