import { env } from "cloudflare:workers";
import type { LifecycleEventInput } from "@flightdeckhq/schema";
import { vi } from "vitest";
import { erasureConfig } from "../../src/lifecycle-erasure/config";
import type { BasinErasureExecutor } from "../../src/lifecycle-erasure/executor";
import { failClosedExecutor } from "../../src/lifecycle-erasure/executor";
import type { ErasureActor, ErasureDeps } from "../../src/lifecycle-erasure/jobs";
import { caseDigest } from "../../src/lifecycle-erasure/spark";
import { forwardOutbox } from "../../src/lifecycle-projection/store";
import { sinks } from "../../src/sinks";
import { makeSigner, type Signer } from "./erasure";
import { adaptFixtures, type DeliveryRecord } from "./fixture-adapter";
import { deliver, producerApp, project } from "./harness";

/** Shared setup for the review-finding regressions (synthetic fixtures only). */

export const MIN = 60_000;
export const DAY = 86_400_000;
export const TABLE = "r2dc.flightdeck.lifecycle_events";
export const ON = {
  LIFECYCLE_ERASURE_MODE: "enforce",
  LIFECYCLE_BASIN_TABLE: TABLE,
  LIFECYCLE_ERASURE_POLICY_VERSION: "erasure-1",
};
export const OP: ErasureActor = { kind: "operator", id: "op_ada", apps: "*" };

export async function loadEvents(): Promise<LifecycleEventInput[]> {
  const records = (
    Object.values(
      import.meta.glob("../../../../examples/lifecycle-fixtures/fixtures/scenarios/*.json", {
        eager: true,
        import: "default",
      }),
    ) as { name: string; records: DeliveryRecord[] }[]
  ).find((s) => s.name === "recruiting-pipeline")?.records;
  return [...(await adaptFixtures(records ?? [])).byApp.values()][0] ?? [];
}

export const rows = (sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>()
    .then((r) => r.results);
export const count = async (sql: string, ...binds: unknown[]) =>
  Number((await rows(sql, ...binds))[0]?.n);

/** A mutable clock shared by deps and runner, so a test can move time deliberately. */
export function clockAt(start: number) {
  const clock = { t: start };
  return {
    clock,
    now: () => clock.t,
    advance: (ms: number) => {
      clock.t += ms;
    },
  };
}

export function erasureDeps(
  signer: Signer,
  now: () => number,
  executor: BasinErasureExecutor = failClosedExecutor,
  vars: Record<string, string> = ON,
): ErasureDeps {
  return { db: env.DB, config: erasureConfig(vars), executor, verifier: signer.verifier, now };
}

let n = 0;
/** A projected app; returns one closed-or-open case id with served rows. */
export async function seedApp(events: LifecycleEventInput[], prefix = "app_rev") {
  const appId = `${prefix}_${++n}`;
  const key = await producerApp(appId);
  await deliver(key, events);
  await project(appId);
  const caseId = (
    await rows(
      "SELECT case_id FROM lifecycle_case_snapshots WHERE app_id = ? ORDER BY case_id LIMIT 1",
      appId,
    )
  )[0]?.case_id as string;
  return { appId, key, caseId };
}

/** Marks every pending row forwarded without calling any sink (a stand-in for a drained outbox). */
export async function markForwarded(appId: string, at = 1) {
  await env.DB.prepare("UPDATE lifecycle_event_log SET forwarded_at = ? WHERE app_id = ?")
    .bind(at, appId)
    .run();
}

export const envOn = () => ({ ...env, ...ON }) as unknown as Env;

/** A sink that holds the first send until released: an outbox invocation paused mid-flight. */
export function pausedSink() {
  const sent: { case_id: string; at: number }[] = [];
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const reached = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  vi.spyOn(sinks, "lifecycle").mockImplementation(async (_e, batch) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    for (const r of batch) sent.push({ case_id: r.case_id, at: Date.now() });
  });
  return { sent, reached, release: () => release() };
}

export type { Signer };
export { caseDigest, forwardOutbox, makeSigner };
