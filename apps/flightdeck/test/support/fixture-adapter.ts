import type { LifecycleEventInput } from "@flightdeckhq/schema";
import { validateEvent } from "../../../../examples/lifecycle-fixtures/lib/model.mjs";
import { PROCESSES } from "../../../../examples/lifecycle-fixtures/lib/processes.mjs";

/**
 * Adapts the synthetic fixtures' own envelope (examples/lifecycle-fixtures, FLIG-20) to the
 * production wire contract: `ProcessDefinitionV1` per entity kind and `LifecycleEventV1` per
 * event. Fixtures are entity-centric; Flightdeck's lifecycle contract is case-centric, so this is
 * a real translation, not a rename. Events the fixtures' validator rejects are reported here and
 * never sent; everything else goes through ingest validation like any producer's events.
 */

export type FixtureEvent = {
  eventId: string;
  appId: string;
  process: string;
  type: string;
  entity: { kind: string; id: string };
  version: number;
  occurredAt: string;
  stage?: { name: string; instanceId: string };
  outcome?: string;
  relations?: { type: string; kind: string; id: string }[];
  attributes?: Record<string, string | number | boolean | null>;
  corrects?: string;
};
export type DeliveryRecord = { receivedAt: string; event: unknown };

/** The fixtures' `process.kind` as one Flightdeck process id. */
export const processIdOf = (process: string, kind: string) => `${process}.${kind}`;

/**
 * Explicit fixture outcome -> engine terminal class. The served outcome keeps the domain code
 * (the `outcome` dimension); the class only decides completed vs. terminated.
 */
export const OUTCOME_CLASS: Record<
  string,
  "completed" | "rejected" | "withdrawn" | "cancelled" | "failed"
> = {
  filled: "completed",
  hired: "completed",
  advance: "completed",
  pass: "completed",
  retired: "completed",
  succeeded: "completed",
  resolved: "completed",
  root_cause_found: "completed",
  fixed: "completed",
  rejected: "rejected",
  reject: "rejected",
  fail: "rejected",
  withdrawn: "withdrawn",
  no_show: "withdrawn",
  cancelled: "cancelled",
  closed_unfilled: "cancelled",
  skipped: "cancelled",
  duplicate: "cancelled",
  wont_fix: "cancelled",
  failed_provisioning: "failed",
  failed: "failed",
  rolled_back: "failed",
  reverted: "failed",
  inconclusive: "failed",
  abandoned: "failed",
};

/**
 * Registered attribute values per kind (the fixtures pick from these lists). Numbers become
 * string codes: dimension values are short codes or booleans, never free numbers.
 */
const ATTRIBUTES: Record<string, { key: string; values: string[] }[]> = {
  assessment: [
    { key: "type", values: ["technical", "behavioral", "case", "system_design"] },
    { key: "attempt", values: ["1", "2", "3"] },
  ],
  service: [{ key: "tier", values: ["internal", "customer_facing", "batch"] }],
  regional_rollout: [
    {
      key: "region",
      values: ["us-east", "us-west", "eu-west", "eu-central", "ap-south", "ap-northeast"],
    },
  ],
  ticket: [{ key: "severity", values: ["sev1", "sev2", "sev3", "sev4"] }],
};

const CASE_RELATIONS = ["child_of", "supersedes", "related_to"].map((type) => ({
  type,
  objectType: "case",
}));

/** One `ProcessDefinitionV1` per fixture entity kind. */
export function fixtureDefinitions() {
  return Object.entries(PROCESSES).flatMap(([process, { kinds }]) =>
    Object.entries(kinds).map(([kind, def]) => {
      return {
        schemaVersion: 1,
        processId: processIdOf(process, kind),
        version: 1,
        name: `${process} ${kind}`.replace(/_/g, " "),
        caseType: kind,
        stages: [...def.stageNames].map((name) => ({
          stageId: name,
          name: name.replace(/_/g, " "),
        })),
        dimensions: [{ key: "outcome", values: def.terminal }, ...(ATTRIBUTES[kind] ?? [])],
        relations: CASE_RELATIONS,
      };
    }),
  );
}

export type Adapted = {
  /** Wire events per fixture app id, in delivery order. */
  byApp: Map<string, LifecycleEventInput[]>;
  /** Fixture events the fixtures' own validator rejects, by reason. Never sent. */
  rejected: Map<string, number>;
};

const encoder = new TextEncoder();

/** A deterministic, valid event id for the retraction a fixture `corrects` implies. */
async function retractionId(eventId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(eventId)));
  return `rx${Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Translates delivery records, in delivery order. A fixture correction ("this event replaces X")
 * becomes `event.corrected { retract X }` plus the replacing event itself: the engine only lets
 * an amendment change time and dimensions, and a fixture correction may change the outcome.
 */
export async function adaptFixtures(records: readonly DeliveryRecord[]): Promise<Adapted> {
  const byApp = new Map<string, LifecycleEventInput[]>();
  const rejected = new Map<string, number>();
  for (const { event: raw } of records) {
    const reason = validateEvent(raw);
    if (reason) {
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
      continue;
    }
    const e = raw as FixtureEvent;
    const out = byApp.get(e.appId) ?? [];
    byApp.set(e.appId, out);
    const base = {
      schemaVersion: 1 as const,
      processId: processIdOf(e.process, e.entity.kind),
      processVersion: 1,
      caseId: e.entity.id,
      occurredAt: Date.parse(e.occurredAt),
      sourceSequence: e.version,
      source: "fixtures",
    };
    if (e.corrects) {
      out.push({
        ...base,
        eventId: await retractionId(e.eventId),
        type: "event.corrected",
        correction: { targetEventId: e.corrects, action: "retract" },
      });
    }
    out.push(toWire(e, base));
  }
  return { byApp, rejected };
}

function toWire(e: FixtureEvent, base: Omit<LifecycleEventInput, "type" | "eventId">) {
  const common = { ...base, eventId: e.eventId };
  const registered = ATTRIBUTES[e.entity.kind] ?? [];
  const dimensions: Record<string, string> = {};
  for (const [key, value] of Object.entries(e.attributes ?? {})) {
    // Only registered attributes become dimensions; anything else fails the test loudly.
    const code = typeof value === "number" ? String(value) : value;
    if (
      typeof code !== "string" ||
      !registered.some((a) => a.key === key && a.values.includes(code))
    ) {
      throw new Error(`unmapped fixture attribute ${key}`);
    }
    dimensions[key] = code;
  }
  const relations = e.relations?.map((r) => ({ type: r.type, objectType: "case", objectId: r.id }));
  const extras = {
    ...(relations?.length ? { relations } : {}),
    ...(Object.keys(dimensions).length ? { dimensions } : {}),
  };
  switch (e.type) {
    case "entity.opened":
      return { ...common, type: "case.started", ...extras } as LifecycleEventInput;
    case "entity.paused":
      return { ...common, type: "case.paused", ...extras } as LifecycleEventInput;
    case "entity.resumed":
      return { ...common, type: "case.resumed", ...extras } as LifecycleEventInput;
    case "entity.reopened":
      return { ...common, type: "case.reopened", ...extras } as LifecycleEventInput;
    case "entity.closed": {
      const outcome = e.outcome as string;
      const terminal = OUTCOME_CLASS[outcome];
      if (!terminal) throw new Error(`unmapped fixture outcome ${outcome}`);
      const closing = { ...common, ...extras, dimensions: { ...dimensions, outcome } };
      return (
        terminal === "completed"
          ? { ...closing, type: "case.completed" }
          : { ...closing, type: "case.terminated", reason: terminal }
      ) as LifecycleEventInput;
    }
    case "stage.entered":
    case "stage.exited": {
      const stage = e.stage as { name: string; instanceId: string };
      return {
        ...common,
        ...extras,
        type: e.type,
        stageId: stage.name,
        stageInstanceId: stage.instanceId,
        ...(e.type === "stage.exited" && e.outcome ? { reason: e.outcome } : {}),
      } as LifecycleEventInput;
    }
    default:
      throw new Error(`unmapped fixture event type ${e.type}`);
  }
}
