import { type LifecycleReadRequest, ProcessDefinitionV1 } from "@flightdeckhq/schema";
import * as v from "valibot";
import type { AccessPrincipal } from "../access";
import { authorizeLifecycleRead } from "../api/authorization";

export const DAY = 86_400_000;
export const WEEK = 7 * DAY;
export const MAX_DURATION = 366 * DAY;
// Conservative reservation units; NOT a promise that D1 can cancel a scan at these limits.
export const COST = { rows: 11_002, scans: 100_000, time_ms: 5_000 } as const;
export const MAX_CASES = 1000;
export const MAX_INTERVALS = 10_000;
export type AggregateRead = Extract<LifecycleReadRequest, { workflowKey: string; from: number }>;
export const isAggregateRead = (q: LifecycleReadRequest): q is AggregateRead =>
  q.method === "getStageDwell" || q.method === "getFunnel" || q.method === "getVariantStats";

export class PrivacyDenied extends Error {
  constructor() {
    super("Aggregate read unavailable");
  }
}
const deny = (): never => {
  throw new PrivacyDenied();
};
export async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export type Reservation = {
  id: string;
  principal: string;
  app: string;
  fingerprint: string;
  stages: ReadonlySet<string>;
};

export async function audit(
  db: D1Database,
  r: Pick<Reservation, "principal" | "app" | "fingerprint">,
  decision: "admitted" | "denied" | "withheld" | "released",
) {
  await db
    .prepare(`INSERT INTO lifecycle_privacy_audit (principal, app, fingerprint, decision)
    VALUES (?, ?, ?, ?)`)
    .bind(r.principal, r.app, r.fingerprint, decision)
    .run();
}

/** One closed Monday-to-Monday UTC week; no unions, rolling or partial cohorts. */
export function canonicalWeek(from: number, to: number, now: number): boolean {
  return (
    Number.isSafeInteger(from) &&
    Number.isSafeInteger(to) &&
    from >= 0 &&
    (from - 4 * DAY) % WEEK === 0 &&
    to - from === WEEK &&
    to <= now
  );
}

/** Call ONLY after the current backend process:read grant check, never caller scope claims.
 * Single conditional INSERT is serialized on D1's primary. No read-then-write counter race,
 * no process-local cache, no location-dependent rate-limit binding and no free replay cache.
 */
export async function reserveAggregate(
  env: Env,
  p: AccessPrincipal,
  appId: string,
  q: AggregateRead,
  now = Date.now(),
): Promise<Reservation> {
  if ((await authorizeLifecycleRead(env, p, appId, "process:read")) instanceof Response)
    return deny();
  if (
    env.LIFECYCLE_PRIVACY_MODE !== "enforce" ||
    !["deny", "reviewed"].includes(env.LIFECYCLE_PRIVACY_RESTRICTED) ||
    !env.LIFECYCLE_PRIVACY_KEY ||
    env.LIFECYCLE_PRIVACY_KEY.length < 32
  )
    return deny();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.LIFECYCLE_PRIVACY_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const opaque = async (value: unknown) =>
    hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(value))));
  const r: Reservation = {
    id: crypto.randomUUID(),
    principal: await opaque(["principal", p.serviceToken ? "service" : "person", p.sub]),
    app: await opaque(["app", appId]),
    // Explicit canonical field order; method aliases using dwell share this fingerprint.
    fingerprint: await opaque([
      "dwell@1",
      appId,
      q.workflowKey,
      q.version,
      q.from,
      q.to,
      q.groupBy,
      Object.entries(q.filters).sort(([a], [b]) => a.localeCompare(b)),
    ]),
    stages: new Set(),
  };
  const rejected = async (): Promise<never> => {
    await audit(env.DB, r, "denied");
    return deny();
  };
  if (
    p.serviceToken ||
    q.method !== "getStageDwell" ||
    !canonicalWeek(q.from, q.to, now) ||
    q.groupBy !== null ||
    Object.keys(q.filters).length
  )
    return rejected();
  const registered = await env.DB.prepare(`SELECT d.definition, p.definition_hash,
      p.classification, p.review_id, p.restricted_approved
    FROM process_definitions d JOIN lifecycle_privacy_processes p
      ON p.app_id = d.app_id AND p.process_id = d.process_id AND p.version = d.version
    WHERE d.app_id = ? AND d.process_id = ? AND d.version = ?`)
    .bind(appId, q.workflowKey, q.version)
    .first<{
      definition: string;
      definition_hash: string;
      classification: string;
      review_id: string;
      restricted_approved: number;
    }>();
  if (
    !registered ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(registered.review_id) ||
    (await digest(registered.definition)) !== registered.definition_hash
  )
    return rejected();
  if (
    registered.classification !== "aggregate" &&
    !(
      registered.classification === "restricted" &&
      registered.restricted_approved === 1 &&
      env.LIFECYCLE_PRIVACY_RESTRICTED === "reviewed"
    )
  )
    return rejected();
  const parsed = v.safeParse(ProcessDefinitionV1, JSON.parse(registered.definition));
  if (
    !parsed.success ||
    parsed.output.processId !== q.workflowKey ||
    parsed.output.version !== q.version
  )
    return rejected();
  r.stages = new Set(parsed.output.stages.map((s) => s.stageId));
  // Budget rows are operator configuration. Missing either row denies; no invented defaults.
  // Principal ceiling spans ALL apps, app ceiling spans ALL principals/tools/processes.
  // Reservation and both predicates are ONE mutation, including concurrent Worker locations.
  const admitted = await env.DB.prepare(`INSERT INTO lifecycle_privacy_ledger
      (id, epoch, principal, app, fingerprint, rows, scans, time_ms)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM authz_grants g JOIN apps a ON a.id = ?
      LEFT JOIN authz_app_projects ap ON ap.app_id = a.id
      WHERE g.principal_kind = 'person' AND g.principal_subject = ?
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ?)
        AND (g.app_id = a.id OR g.project_id = ap.project_id)
        AND g.role IN ('analyst', 'owner', 'admin'))
    AND (SELECT count(*) FROM lifecycle_privacy_limits
      WHERE (kind = 'app' AND scope = ?) OR (kind = 'principal' AND scope = 'global')) = 2
    AND NOT EXISTS (
      SELECT 1 FROM lifecycle_privacy_limits l
      WHERE ((l.kind = 'app' AND l.scope = ?) OR (l.kind = 'principal' AND l.scope = 'global'))
      AND (
        (SELECT count(*) FROM lifecycle_privacy_ledger u WHERE u.epoch = ? AND
          ((l.kind = 'app' AND u.app = ?) OR (l.kind = 'principal' AND u.principal = ?))) + 1 > l.query_count
        OR (SELECT coalesce(sum(rows), 0) FROM lifecycle_privacy_ledger u WHERE u.epoch = ? AND
          ((l.kind = 'app' AND u.app = ?) OR (l.kind = 'principal' AND u.principal = ?))) + ? > l.row_budget
        OR (SELECT coalesce(sum(scans), 0) FROM lifecycle_privacy_ledger u WHERE u.epoch = ? AND
          ((l.kind = 'app' AND u.app = ?) OR (l.kind = 'principal' AND u.principal = ?))) + ? > l.scan_budget
        OR (SELECT coalesce(sum(time_ms), 0) FROM lifecycle_privacy_ledger u WHERE u.epoch = ? AND
          ((l.kind = 'app' AND u.app = ?) OR (l.kind = 'principal' AND u.principal = ?))) + ? > l.time_budget_ms
      )) RETURNING id`)
    .bind(
      r.id,
      Math.floor(now / DAY),
      r.principal,
      r.app,
      r.fingerprint,
      COST.rows,
      COST.scans,
      COST.time_ms,
      appId,
      p.sub,
      now,
      appId,
      appId,
      Math.floor(now / DAY),
      r.app,
      r.principal,
      Math.floor(now / DAY),
      r.app,
      r.principal,
      COST.rows,
      Math.floor(now / DAY),
      r.app,
      r.principal,
      COST.scans,
      Math.floor(now / DAY),
      r.app,
      r.principal,
      COST.time_ms,
    )
    .all<{ id: string }>();
  if (admitted.results.length !== 1) return rejected();
  // Audit failure denies execution; the already spent reservation is deliberately retained.
  await audit(env.DB, r, "admitted");
  return r;
}

/** Record max(reserved, observed) even on failure. No refunds; overrun withholds output.
 * Physical D1 scan/CPU cannot be bounded by LIMIT or cancelled mid-statement here.
 */
export async function finishReservation(
  db: D1Database,
  r: Reservation,
  used: { rows: number; scans: number; time_ms: number },
) {
  await db
    .prepare(`UPDATE lifecycle_privacy_ledger SET rows = max(rows, ?),
    scans = max(scans, ?), time_ms = max(time_ms, ?) WHERE id = ?`)
    .bind(used.rows, used.scans, used.time_ms, r.id)
    .run();
  if (used.rows > COST.rows || used.scans > COST.scans || used.time_ms > COST.time_ms) deny();
}
