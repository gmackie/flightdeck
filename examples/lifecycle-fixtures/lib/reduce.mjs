// Reference reducer: delivered records -> entity records, violations and ground-truth summary.
//
// Fixture semantics (documented in README "Reference semantics"):
//  - invalid events are rejected and have no effect;
//  - dedupe on (appId, eventId): first delivery wins, identical redeliveries are duplicates,
//    differing payloads are duplicate conflicts;
//  - `corrects: X` supersedes X wherever it arrives, so the result is independent of delivery order;
//  - an entity's state is its events ordered by `version`, never by arrival.
// This is a test oracle for the fixtures, not the product engine.
import { createHash } from "node:crypto";
import { validateEvent } from "./model.mjs";
import { PROCESSES } from "./processes.mjs";
import { ensure, parseIso, percentile } from "./util.mjs";

const SEP = "\u0000";
const digest = (event) =>
  createHash("sha1").update(JSON.stringify(event)).digest("hex").slice(0, 20);

export class Reducer {
  constructor() {
    this.deliveries = 0;
    this.invalid = { count: 0, byReason: {} };
    this.duplicateDeliveries = 0;
    this.duplicateConflicts = 0;
    this.seen = new Map();
    this.events = [];
    this.corrected = new Set();
    this.corrections = [];
  }

  rejectEvent(reason) {
    this.invalid.count++;
    this.invalid.byReason[reason] = (this.invalid.byReason[reason] ?? 0) + 1;
  }

  /** @param {{ event?: unknown }} record one delivery */
  add(record) {
    this.deliveries++;
    const event = record?.event;
    const reason = validateEvent(event);
    if (reason) return this.rejectEvent(reason);
    const key = event.appId + SEP + event.eventId;
    const d = digest(event);
    const prev = this.seen.get(key);
    if (prev !== undefined) {
      if (prev === d) this.duplicateDeliveries++;
      else this.duplicateConflicts++;
      return;
    }
    this.seen.set(key, d);
    this.events.push(event);
    if (event.corrects) {
      this.corrected.add(event.appId + SEP + event.corrects);
      this.corrections.push(event);
    }
  }

  /** @param {{ asOf?: number }} [opts] default asOf is the latest applied occurredAt */
  finish({ asOf } = {}) {
    const violations = [];
    const violate = (code, ev, detail = "") =>
      violations.push({
        code,
        appId: ev.appId,
        kind: ev.entity.kind,
        id: ev.entity.id,
        version: ev.version,
        detail,
      });

    let supersededOriginals = 0;
    const targets = new Map();
    const buckets = new Map();
    for (const ev of this.events) {
      const key = ev.appId + SEP + ev.eventId;
      if (this.corrected.has(key)) {
        supersededOriginals++;
        targets.set(key, ev);
        continue;
      }
      const ek = ev.appId + SEP + ev.entity.kind + SEP + ev.entity.id;
      ensure(buckets, ek, () => []).push(ev);
    }
    for (const c of this.corrections) {
      const t = targets.get(c.appId + SEP + c.corrects);
      if (
        t &&
        (t.entity.id !== c.entity.id || t.entity.kind !== c.entity.kind || t.version !== c.version)
      ) {
        violate("correction_mismatch", c, `corrects ${c.corrects} of another entity/version`);
      }
    }

    const entities = [];
    let appliedEvents = 0;
    let maxTs = 0;
    for (const bucket of buckets.values()) {
      const entered = new Set();
      for (const ev of bucket) if (ev.type === "stage.entered") entered.add(ev.stage.instanceId);
      const kept = [];
      for (const ev of bucket) {
        if (ev.type === "stage.exited" && !entered.has(ev.stage.instanceId)) {
          this.rejectEvent("orphan_stage_exit");
        } else kept.push(ev);
      }
      if (kept.length === 0) continue;
      kept.sort((a, b) => a.version - b.version);
      const unique = [];
      for (const ev of kept) {
        const prev = unique[unique.length - 1];
        if (prev && prev.version === ev.version)
          violate("conflicting_version", ev, "same slot twice");
        else unique.push(ev);
      }
      unique.forEach((ev, i) => {
        if (ev.version !== i + 1) violate("version_gap", ev, `expected version ${i + 1}`);
      });
      appliedEvents += unique.length;
      const rec = applyEntity(unique, violate);
      for (const ev of unique) maxTs = Math.max(maxTs, parseIso(ev.occurredAt));
      entities.push(rec);
    }

    checkRelations(entities, violations);
    entities.sort((a, b) => cmp(a.appId, b.appId) || cmp(a.kind, b.kind) || cmp(a.id, b.id));
    const effectiveAsOf = asOf ?? maxTs;
    return {
      asOf: effectiveAsOf,
      entities,
      violations,
      totals: {
        deliveries: this.deliveries,
        invalid: {
          count: this.invalid.count,
          byReason: sortKeys(this.invalid.byReason),
        },
        duplicateDeliveries: this.duplicateDeliveries,
        duplicateConflicts: this.duplicateConflicts,
        corrections: this.corrections.length,
        supersededOriginals,
        appliedEvents,
      },
    };
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b)));

function applyEntity(events, violate) {
  const first = events[0];
  const rec = {
    appId: first.appId,
    process: first.process,
    kind: first.entity.kind,
    id: first.entity.id,
    version: events[events.length - 1].version,
    status: "new",
    outcome: null,
    openedAt: null,
    closedAt: null,
    reopenCount: 0,
    pausedMs: 0,
    pausedSince: null,
    relations: [],
    attributes: {},
    stageInstances: [],
  };
  const byInstance = new Map();
  const openByName = new Map();
  let last = Number.NEGATIVE_INFINITY;
  for (const ev of events) {
    const ts = parseIso(ev.occurredAt);
    if (ts < last) violate("time_regression", ev, `${ev.occurredAt} precedes a lower version`);
    last = Math.max(last, ts);
    const live = rec.status === "open" || rec.status === "paused";
    switch (ev.type) {
      case "entity.opened":
        if (rec.status !== "new") violate("duplicate_open", ev);
        rec.status = "open";
        rec.openedAt = ts;
        rec.relations = ev.relations ?? [];
        rec.attributes = ev.attributes ?? {};
        break;
      case "stage.entered": {
        if (rec.status === "new") violate("missing_open", ev);
        else if (!live) violate("stage_on_closed", ev);
        const { name, instanceId } = ev.stage;
        if (byInstance.has(instanceId)) violate("duplicate_stage_instance", ev);
        if (openByName.has(name)) violate("duplicate_open_stage", ev, name);
        const inst = { id: instanceId, name, enteredAt: ts, exitedAt: null, outcome: null };
        byInstance.set(instanceId, inst);
        openByName.set(name, inst);
        rec.stageInstances.push(inst);
        break;
      }
      case "stage.exited": {
        const inst = byInstance.get(ev.stage.instanceId);
        if (!inst || inst.exitedAt !== null) violate("stage_exit_unmatched", ev);
        else {
          if (inst.name !== ev.stage.name) violate("stage_name_mismatch", ev);
          inst.exitedAt = ts;
          inst.outcome = ev.outcome;
          openByName.delete(inst.name);
        }
        break;
      }
      case "entity.paused":
        if (rec.status !== "open") violate("pause_invalid", ev, rec.status);
        else {
          rec.status = "paused";
          rec.pausedSince = ts;
        }
        break;
      case "entity.resumed":
        if (rec.status !== "paused") violate("resume_invalid", ev, rec.status);
        else {
          rec.status = "open";
          rec.pausedMs += ts - rec.pausedSince;
          rec.pausedSince = null;
        }
        break;
      case "entity.closed":
        if (!live) violate("close_invalid", ev, rec.status);
        if (openByName.size) violate("close_with_open_stage", ev, [...openByName.keys()].join(","));
        if (rec.pausedSince !== null) {
          rec.pausedMs += ts - rec.pausedSince;
          rec.pausedSince = null;
        }
        rec.status = "closed";
        rec.outcome = ev.outcome;
        rec.closedAt = ts;
        break;
      case "entity.reopened":
        if (rec.status !== "closed") violate("reopen_invalid", ev, rec.status);
        else {
          rec.status = "open";
          rec.outcome = null;
          rec.closedAt = null;
          rec.reopenCount++;
        }
        break;
    }
  }
  return rec;
}

function checkRelations(entities, violations) {
  const index = new Map();
  for (const e of entities) index.set(e.appId + SEP + e.kind + SEP + e.id, e);
  const push = (code, e, detail) =>
    violations.push({ code, appId: e.appId, kind: e.kind, id: e.id, version: e.version, detail });
  for (const e of entities) {
    const def = PROCESSES[e.process]?.kinds[e.kind];
    let parentCount = 0;
    for (const r of e.relations) {
      // Targets resolve only inside the entity's own app: scope never leaks across apps.
      const target = index.get(e.appId + SEP + r.kind + SEP + r.id);
      if (!target) {
        push("dangling_relation", e, `${r.type} ${r.kind}/${r.id}`);
        continue;
      }
      if (r.type === "child_of") {
        parentCount++;
        if (def?.parent !== r.kind) push("wrong_parent_kind", e, `${r.kind}`);
        if (target.openedAt > e.openedAt) push("child_before_parent", e, `${r.kind}/${r.id}`);
        if (target.status === "closed" && e.status !== "closed") {
          push("closed_parent_open_child", e, `${r.kind}/${r.id}`);
        }
        if (target.status === "closed" && e.status === "closed" && e.closedAt > target.closedAt) {
          push("child_closed_after_parent", e, `${r.kind}/${r.id}`);
        }
      } else if (r.type === "supersedes") {
        if (r.kind !== e.kind || target.openedAt > e.openedAt) push("bad_supersedes", e, r.id);
      }
    }
    if (def?.parent && parentCount !== 1) push("missing_parent", e, `${def.parent}`);
    if (!def?.parent && parentCount > 0) push("unexpected_parent", e);
  }
}

/** Reduce an iterable of delivery records in one go. */
export function reduceRecords(records, opts) {
  const r = new Reducer();
  for (const rec of records) r.add(rec);
  return r.finish(opts);
}

// ---------------------------------------------------------------------------------------------
// Summary: the ground-truth shape shared by the generator and the reducer.

const dwellStats = (values, withPercentiles) => {
  if (values.length === 0) return { count: 0 };
  values.sort((a, b) => a - b);
  let sum = 0;
  for (const v of values) sum += v;
  const out = { count: values.length, sumMs: sum, maxMs: values[values.length - 1] };
  if (withPercentiles) {
    out.minMs = values[0];
    out.p50Ms = percentile(values, 0.5);
    out.p95Ms = percentile(values, 0.95);
  }
  return out;
};

/** Peak number of simultaneously-open intervals; ends sort before starts at the same instant. */
function peakOverlap(intervals) {
  if (intervals.length < 2) return intervals.length;
  const points = [];
  for (const [s, e] of intervals) points.push([s, 1], [e, -1]);
  points.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  let cur = 0;
  let peak = 0;
  for (const [, d] of points) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

/**
 * @param {object[]} entities entity records
 * @param {number} asOf epoch ms; open stage dwell and live pauses are measured up to here
 */
export function summarize(entities, asOf) {
  const apps = {};
  const childGroups = new Map();
  for (const e of entities) {
    const app = ensure(apps, e.appId, () => ({
      processes: new Set(),
      kinds: {},
      stages: {},
      relations: {},
    }));
    app.processes.add(e.process);
    const k = ensure(app.kinds, e.kind, () => ({
      total: 0,
      status: { open: 0, paused: 0, closed: 0 },
      outcomes: {},
      reopenedEntities: 0,
      reopenEvents: 0,
      pausedMsTotal: 0,
      parallelStageEntities: 0,
      peakConcurrentPerParent: 0,
    }));
    k.total++;
    k.status[e.status]++;
    if (e.status === "closed") k.outcomes[e.outcome] = (k.outcomes[e.outcome] ?? 0) + 1;
    if (e.reopenCount > 0) k.reopenedEntities++;
    k.reopenEvents += e.reopenCount;
    k.pausedMsTotal += e.pausedMs + (e.pausedSince === null ? 0 : asOf - e.pausedSince);

    const spans = [];
    for (const s of e.stageInstances) {
      const st = ensure(app.stages, `${e.kind}/${s.name}`, () => ({
        entered: 0,
        exited: 0,
        open: 0,
        outcomes: {},
        closed: [],
        openDwell: [],
      }));
      st.entered++;
      if (s.exitedAt === null) {
        st.open++;
        st.openDwell.push(asOf - s.enteredAt);
        spans.push([s.enteredAt, Number.POSITIVE_INFINITY]);
      } else {
        st.exited++;
        st.outcomes[s.outcome] = (st.outcomes[s.outcome] ?? 0) + 1;
        st.closed.push(s.exitedAt - s.enteredAt);
        spans.push([s.enteredAt, s.exitedAt]);
      }
    }
    if (peakOverlap(spans) > 1) k.parallelStageEntities++;

    for (const r of e.relations) {
      app.relations[r.type] = (app.relations[r.type] ?? 0) + 1;
      if (r.type === "child_of") {
        const gk = `${e.appId}${SEP}${r.kind}${SEP}${r.id}${SEP}${e.kind}`;
        ensure(childGroups, gk, () => ({ appId: e.appId, kind: e.kind, spans: [] })).spans.push([
          e.openedAt,
          e.closedAt ?? Number.POSITIVE_INFINITY,
        ]);
      }
    }
  }
  for (const g of childGroups.values()) {
    const k = apps[g.appId].kinds[g.kind];
    k.peakConcurrentPerParent = Math.max(k.peakConcurrentPerParent, peakOverlap(g.spans));
  }

  const perApp = {};
  for (const appId of Object.keys(apps).sort()) {
    const a = apps[appId];
    const kinds = {};
    for (const kind of Object.keys(a.kinds).sort()) {
      const k = a.kinds[kind];
      kinds[kind] = { ...k, outcomes: sortKeys(k.outcomes) };
    }
    const stages = {};
    for (const name of Object.keys(a.stages).sort()) {
      const s = a.stages[name];
      stages[name] = {
        entered: s.entered,
        exited: s.exited,
        open: s.open,
        outcomes: sortKeys(s.outcomes),
        closedDwell: dwellStats(s.closed, true),
        openDwell: dwellStats(s.openDwell, false),
      };
    }
    perApp[appId] = {
      processes: [...a.processes].sort(),
      entities: kinds,
      stages,
      relations: sortKeys(a.relations),
    };
  }
  return perApp;
}
