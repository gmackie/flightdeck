// The event envelope and its validator.
//
// This is the fixtures' own contract, modelled on the existing ingest conventions (opaque ids of
// 8-64 [A-Za-z0-9_-] chars, one app scope per event, dedupe on (appId, eventId)). It is NOT the
// production /v1/lifecycle/events schema (owned by another workstream); see README "Assumptions".

import { PROCESSES, RELATION_TYPES, STAGE_OUTCOMES } from "./processes.mjs";
import { parseIso } from "./util.mjs";

export const EVENT_TYPES = [
  "entity.opened",
  "stage.entered",
  "stage.exited",
  "entity.paused",
  "entity.resumed",
  "entity.closed",
  "entity.reopened",
];
const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const STAGE_OUTCOME_SET = new Set(STAGE_OUTCOMES);
const RELATION_TYPE_SET = new Set(RELATION_TYPES);

export const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Every reason `validateEvent` (or the stream-level orphan check) can reject an event. */
export const INVALID_REASONS = [
  "not_an_object",
  "missing_event_id",
  "bad_event_id_format",
  "missing_app_id",
  "bad_app_id",
  "unknown_type",
  "bad_occurred_at",
  "missing_entity",
  "bad_entity_id",
  "unknown_process",
  "unknown_kind",
  "bad_version",
  "missing_stage",
  "unknown_stage",
  "missing_outcome",
  "unknown_outcome",
  "bad_relation",
  "self_relation",
  "bad_corrects",
  "bad_attributes",
  // Stream-level: needs the whole entity history, so it is raised by the reducer.
  "orphan_stage_exit",
];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** First failing check for one event, or null. Checks run in a fixed order so reasons are stable. */
export function validateEvent(e) {
  if (!isObj(e)) return "not_an_object";
  if (e.eventId === undefined || e.eventId === null || e.eventId === "") return "missing_event_id";
  if (typeof e.eventId !== "string" || !ID_RE.test(e.eventId)) return "bad_event_id_format";
  if (e.appId === undefined || e.appId === null || e.appId === "") return "missing_app_id";
  if (typeof e.appId !== "string" || !ID_RE.test(e.appId)) return "bad_app_id";
  if (!EVENT_TYPE_SET.has(e.type)) return "unknown_type";
  if (Number.isNaN(parseIso(e.occurredAt))) return "bad_occurred_at";
  if (!isObj(e.entity) || !e.entity.kind || e.entity.id === undefined) return "missing_entity";
  if (typeof e.entity.id !== "string" || !ID_RE.test(e.entity.id)) return "bad_entity_id";
  const proc = PROCESSES[e.process];
  if (!proc) return "unknown_process";
  const def = proc.kinds[e.entity.kind];
  if (!def) return "unknown_kind";
  if (!Number.isInteger(e.version) || e.version < 1) return "bad_version";
  if (e.type === "stage.entered" || e.type === "stage.exited") {
    const s = e.stage;
    if (!isObj(s) || typeof s.name !== "string" || !ID_RE.test(s.instanceId ?? "")) {
      return "missing_stage";
    }
    if (!def.stageNames.has(s.name)) return "unknown_stage";
  }
  if (e.type === "stage.exited" || e.type === "entity.closed") {
    if (e.outcome === undefined || e.outcome === null || e.outcome === "") return "missing_outcome";
    const ok =
      e.type === "stage.exited" ? STAGE_OUTCOME_SET.has(e.outcome) : def.terminalSet.has(e.outcome);
    if (!ok) return "unknown_outcome";
  }
  if (e.relations !== undefined) {
    if (!Array.isArray(e.relations)) return "bad_relation";
    for (const r of e.relations) {
      if (
        !isObj(r) ||
        !RELATION_TYPE_SET.has(r.type) ||
        !proc.kinds[r.kind] ||
        typeof r.id !== "string" ||
        !ID_RE.test(r.id)
      ) {
        return "bad_relation";
      }
      if (r.kind === e.entity.kind && r.id === e.entity.id) return "self_relation";
    }
  }
  if (e.corrects !== undefined && (typeof e.corrects !== "string" || !ID_RE.test(e.corrects))) {
    return "bad_corrects";
  }
  if (e.attributes !== undefined) {
    if (!isObj(e.attributes)) return "bad_attributes";
    for (const v of Object.values(e.attributes)) {
      if (v !== null && !["string", "number", "boolean"].includes(typeof v))
        return "bad_attributes";
    }
  }
  return null;
}
