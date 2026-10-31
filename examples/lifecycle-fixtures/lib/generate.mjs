// Deterministic synthetic lifecycle generator.
//
// generate(config) walks entity trees through the process definitions (lib/processes.mjs), then
// layers on delivery effects. The returned `truth` comes from the generator's own simulation
// records, independently of the reducer that re-derives it from the delivered events.
import { createContext, EntityBuilder } from "./builder.mjs";
import { INVALID_REASONS } from "./model.mjs";
import { createRng } from "./prng.mjs";
import { PROCESS_NAMES, PROCESSES, STAGE_OUTCOMES } from "./processes.mjs";
import { summarize } from "./reduce.mjs";
import { DAY, HOUR, MINUTE, parseIso, toIso } from "./util.mjs";

export const DEFAULT_START = "2026-01-05T00:00:00.000Z";
export const DEFAULT_APPS = [
  { appId: "app_talent", processes: ["recruiting"] },
  { appId: "app_platform", processes: ["service_delivery"] },
  { appId: "app_support", processes: ["incident_response"] },
];

/** Delivery/noise profiles. Rates are per event unless noted. */
export const PROFILES = {
  // Prompt, orderly, valid delivery.
  clean: { lateRate: 0, dupRate: 0, correctionRate: 0, invalidRate: 0, reverseRate: 0 },
  default: {
    lateRate: 0.12,
    dupRate: 0.02,
    correctionRate: 0.015,
    invalidRate: 0.01,
    reverseRate: 0.02,
  },
  hostile: {
    lateRate: 0.4,
    dupRate: 0.08,
    correctionRate: 0.05,
    invalidRate: 0.04,
    reverseRate: 0.1,
  },
};

const MAX_DWELL = 365 * DAY;

function sampleDwell(rng, [median, sigma], { tail = 0.03, tailMult = [6, 25] } = {}) {
  let v = median * Math.exp(sigma * rng.gauss());
  if (tail > 0 && rng.chance(tail)) v *= rng.range(tailMult[0], tailMult[1]);
  return Math.max(1000, Math.min(Math.round(v), MAX_DWELL));
}

/**
 * Walk one entity (and, recursively, its children) through its stages.
 * `deadline`: a parent's cancellation; the entity is force-closed `cancelled` then.
 * Returns `{ id, end, outcome }`; `end` is Infinity when the entity is still open at the horizon.
 */
function runEntity(g, def, { start, deadline, ancestors, relations, attributes }) {
  const { rng, ctx } = g;
  const b = new EntityBuilder(ctx, def.kind);
  g.builders.push(b);
  b.open(start, { relations, attributes });
  const result = (end = Number.POSITIVE_INFINITY, outcome = null) =>
    b.cut ? { id: b.id, end: Number.POSITIVE_INFINITY, outcome: null } : { id: b.id, end, outcome };
  if (b.cut) return result();

  const chain = [{ kind: def.kind, id: b.id }, ...ancestors];
  const forceClose = (at) => {
    const ts = Math.max(at, b.lastTs);
    for (const name of b.openStageNames()) b.exit(name, "terminated", ts);
    b.close("cancelled", ts);
    return result(ts, "cancelled");
  };

  const last = def.stages.length - 1;
  let t = start;
  let outcome = null;
  let closeTs = start;
  let finalKids = [];
  for (let i = 0; i <= last && outcome === null; i++) {
    if (t >= deadline) return forceClose(deadline);
    const s = def.stages[i];
    b.enter(s.name, t);
    if (b.cut) return result();

    const d = sampleDwell(rng, s.dwell, s);
    const abortAt =
      s.abortProb && rng.chance(s.abortProb)
        ? t + Math.round(d * rng.range(0.3, 1))
        : Number.POSITIVE_INFINITY;
    const limit = Math.min(deadline, abortAt);
    const ops = [];
    let pd = 0;
    if (s.pause && rng.chance(s.pause.prob)) {
      const at = t + Math.round(d * rng.range(0.1, 0.8));
      pd = sampleDwell(rng, s.pause.dwell, { tail: 0 });
      ops.push({ ts: at, run: () => b.pause(at) }, { ts: at + pd, run: () => b.resume(at + pd) });
    }
    let sideOpen = false;
    if (def.side && def.side.from === s.name && rng.chance(def.side.prob)) {
      const at = t + Math.round(d * rng.range(0.05, 0.3));
      sideOpen = true;
      ops.push({ ts: at, run: () => b.enter(def.side.name, at) });
    }

    let kids = [];
    let childEnd = 0;
    if (s.spawn) {
      kids = spawnChildren(g, def, s, b, chain, t, d, limit);
      for (const k of kids) childEnd = Math.max(childEnd, k.end);
    }
    const end = Math.max(t + d + pd, childEnd);
    if (sideOpen) ops.push({ ts: end, run: () => b.exit(def.side.name, "completed", end) });

    ops.sort((x, y) => x.ts - y.ts);
    for (const op of ops) if (op.ts < limit) op.run();

    if (end >= limit) return limit === Number.POSITIVE_INFINITY ? result() : forceClose(limit);

    let next = "next";
    if (s.onChildren)
      next = s.onChildren(
        kids.map((k) => k.outcome),
        rng,
      );
    if (next === "next" && s.advance !== undefined && !rng.chance(s.advance)) {
      next = rng.weighted(s.exits);
    }
    closeTs = end;
    if (next !== "next") {
      for (const name of b.openStageNames()) b.exit(name, "terminated", end);
      outcome = next;
    } else if (i === last) {
      b.exit(s.name, "completed", end);
      outcome = rng.weighted(def.final);
    } else {
      b.exit(s.name, "advanced", end);
      t = end;
      finalKids = kids;
    }
  }
  void finalKids;
  b.close(outcome, closeTs);
  if (b.cut) return result();

  const ro = def.reopen;
  if (ro && rng.chance(ro.prob)) {
    const rt = closeTs + sampleDwell(rng, ro.gap, { tail: 0 });
    if (rt < deadline) {
      b.reopen(rt);
      b.enter(ro.stage, rt);
      const re = rt + sampleDwell(rng, ro.dwell, { tail: 0 });
      if (re >= deadline) return forceClose(deadline);
      outcome = rng.weighted(ro.outcomes);
      b.exit(ro.stage, "completed", re);
      b.close(outcome, re);
      closeTs = re;
    }
  }
  return result(closeTs, outcome);
}

function spawnChildren(g, def, s, b, chain, t, d, limit) {
  const { rng } = g;
  const sp = s.spawn;
  const childDef = PROCESSES[b.process].kinds[sp.kind];
  const childDeadline = limit === Number.POSITIVE_INFINITY ? limit : limit - 10;
  const n = rng.int(sp.count[0], sp.count[1]);
  const results = [];
  for (let j = 0; j < n; j++) {
    const start = t + Math.round(d * sp.within * rng.float());
    if (start >= childDeadline) continue;
    const relations = [{ type: "child_of", kind: def.kind, id: b.id }];
    if (childDef.relatedTo) {
      const anc = chain.find((c) => c.kind === childDef.relatedTo);
      if (anc) relations.push({ type: "related_to", kind: anc.kind, id: anc.id });
    }
    const attributes = childDef.attrs ? childDef.attrs(rng, j) : {};
    let slot = runEntity(g, childDef, {
      start,
      deadline: childDeadline,
      ancestors: chain,
      relations,
      attributes,
    });
    if (
      sp.retry &&
      slot.outcome &&
      sp.retry.when.includes(slot.outcome) &&
      rng.chance(sp.retry.prob)
    ) {
      const retryStart = slot.end + sampleDwell(rng, sp.retry.gap, { tail: 0 });
      if (retryStart < childDeadline) {
        slot = runEntity(g, childDef, {
          start: retryStart,
          deadline: childDeadline,
          ancestors: chain,
          relations: [...relations, { type: "supersedes", kind: childDef.kind, id: slot.id }],
          attributes: { ...attributes, attempt: 2 },
        });
      }
    }
    results.push(slot);
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// Delivery layer: when each event is received, plus duplicates, corrections and invalid events.

export function breakEvent(reason, src, nrng, ctx) {
  const e = structuredClone(src);
  e.eventId = ctx.newEventId();
  switch (reason) {
    case "missing_event_id":
      delete e.eventId;
      break;
    case "bad_event_id_format":
      e.eventId = "bad id!";
      break;
    case "missing_app_id":
      delete e.appId;
      break;
    case "bad_app_id":
      e.appId = "not a valid app";
      break;
    case "unknown_type":
      e.type = "entity.exploded";
      break;
    case "bad_occurred_at":
      e.occurredAt = nrng.pick(["yesterday", "2026-13-45T00:00:00.000Z", "2026-02-03"]);
      break;
    case "missing_entity":
      delete e.entity;
      break;
    case "bad_entity_id":
      e.entity.id = "x";
      break;
    case "unknown_process":
      e.process = "alchemy";
      break;
    case "unknown_kind":
      e.entity.kind = "banana";
      break;
    case "bad_version":
      e.version = nrng.pick([0, -3, 1.5, "3"]);
      break;
    case "missing_stage":
      delete e.stage;
      break;
    case "unknown_stage":
      e.stage.name = "nope";
      break;
    case "missing_outcome":
      delete e.outcome;
      break;
    case "unknown_outcome":
      e.outcome = "banana";
      break;
    case "bad_relation":
      e.relations = [{ type: "friend_of", kind: e.entity.kind, id: "someone12345" }];
      break;
    case "self_relation":
      e.relations = [{ type: "child_of", kind: e.entity.kind, id: e.entity.id }];
      break;
    case "bad_corrects":
      e.corrects = "short";
      break;
    case "bad_attributes":
      e.attributes = { nested: { not: "scalar" } };
      break;
    case "orphan_stage_exit":
      e.stage.instanceId = ctx.newStageId();
      e.version = 999999;
      break;
    default:
      throw new Error(`no injector for ${reason}`);
  }
  return e;
}

// Which clean event types can seed each invalid reason.
const SOURCE_TYPE = {
  missing_stage: ["stage.entered", "stage.exited"],
  unknown_stage: ["stage.entered", "stage.exited"],
  missing_outcome: ["stage.exited", "entity.closed"],
  unknown_outcome: ["stage.exited", "entity.closed"],
  orphan_stage_exit: ["stage.exited"],
  self_relation: ["entity.opened"],
};

function deliveries(g, profile, nrng, stats) {
  const out = [];
  const pool = [];
  const lag = (ts, event) => {
    let ms = nrng.int(20, 2500);
    if (nrng.chance(profile.lateRate)) {
      ms = Math.round(Math.exp(nrng.range(Math.log(2 * MINUTE), Math.log(3 * DAY))));
    }
    // Delayed scorecard: the write-up is submitted late, and then reaches us late too.
    if (
      profile.lateRate > 0 &&
      event.stage?.name === "scorecard_pending" &&
      event.type === "stage.exited" &&
      nrng.chance(0.5)
    ) {
      ms += nrng.int(0, 2 * DAY);
    }
    return ts + ms;
  };
  const push = (event, recv) => {
    out.push({ recv, event });
    if (nrng.chance(profile.dupRate)) {
      out.push({ recv: recv + (nrng.chance(0.3) ? 0 : nrng.int(1, 6 * HOUR)), event });
      stats.duplicateDeliveries++;
    }
  };

  for (const b of g.builders) {
    const n = b.events.length;
    if (n === 0) continue;
    const recv = b.events.map(({ ts, event }) => lag(ts, event));
    if (n >= 4 && nrng.chance(profile.reverseRate)) {
      // The whole history arrives at once, newest first.
      const base = lag(b.events[n - 1].ts, b.events[n - 1].event);
      for (let k = 0; k < n; k++) recv[k] = base + (n - 1 - k) * 3;
    }
    for (let k = 0; k < n; k++) {
      const { ts, event } = b.events[k];
      pool.push({ event, recv: recv[k] });
      if (!nrng.chance(profile.correctionRate)) {
        push(event, recv[k]);
        continue;
      }
      // Publish a wrong version of this event, then a correction carrying the truth.
      const def = PROCESSES[b.process].kinds[b.kind];
      const wrong = structuredClone(event);
      const vocab =
        event.type === "stage.exited"
          ? STAGE_OUTCOMES
          : event.type === "entity.closed"
            ? def.terminal
            : null;
      const next = b.events[k + 1]?.ts;
      const room = next === undefined ? HOUR : Math.min(HOUR, next - ts - 1);
      if (vocab && (room < 1 || nrng.chance(0.5))) {
        wrong.outcome = nrng.pick(vocab.filter((o) => o !== event.outcome));
      } else if (room >= 1) {
        wrong.occurredAt = toIso(ts + nrng.int(1, room));
      } else {
        push(event, recv[k]);
        continue;
      }
      const fix = {
        ...structuredClone(event),
        eventId: g.ctx.newEventId(),
        corrects: event.eventId,
      };
      const early = nrng.chance(0.1);
      const fixRecv = early
        ? Math.max(ts + 1, recv[k] - nrng.int(1000, HOUR))
        : recv[k] + nrng.int(MINUTE, 2 * DAY);
      push(wrong, recv[k]);
      push(fix, fixRecv);
      stats.corrections++;
      stats.supersededOriginals++;
    }
  }

  // Invalid events: single-defect clones of real events, cycling through every reason.
  const validCount = out.length;
  const wanted = profile.invalidRate
    ? Math.max(
        Math.ceil(validCount * profile.invalidRate),
        validCount >= 150 ? INVALID_REASONS.length + 1 : 0,
      )
    : 0;
  for (let i = 0; i < wanted && pool.length; i++) {
    const reason =
      i === wanted - 1 && wanted > INVALID_REASONS.length
        ? "not_an_object"
        : INVALID_REASONS[i % INVALID_REASONS.length];
    const types = SOURCE_TYPE[reason];
    let src = null;
    for (let tries = 0; tries < 200 && !src; tries++) {
      const cand = nrng.pick(pool);
      if (!types || types.includes(cand.event.type)) src = cand;
    }
    if (!src) continue;
    const event =
      reason === "not_an_object" ? "garbage" : breakEvent(reason, src.event, nrng, g.ctx);
    out.push({ recv: src.recv + nrng.int(0, 60_000), event });
    stats.invalid.count++;
    stats.invalid.byReason[reason] = (stats.invalid.byReason[reason] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {object} cfg
 * @param {string} cfg.seed structure + noise seed
 * @param {string} [cfg.idSeed] id seed; apps sharing it mint colliding ids (default: shared)
 * @param {boolean} [cfg.distinctIds] give each app its own id stream instead
 * @param {number} cfg.events approximate total events (stops on the first tree boundary past it)
 * @param {{appId: string, processes: string[]}[]} [cfg.apps]
 * @param {string} [cfg.start] ISO start of the observation window
 * @param {number} [cfg.spanDays] window length; asOf = start + span
 * @param {keyof typeof PROFILES | object} [cfg.profile]
 */
export function generate(cfg) {
  const apps = cfg.apps ?? DEFAULT_APPS;
  const profile =
    typeof cfg.profile === "object" ? cfg.profile : PROFILES[cfg.profile ?? "default"];
  if (!profile) throw new Error(`unknown profile ${cfg.profile}`);
  const start = parseIso(cfg.start ?? DEFAULT_START);
  const spanMs = (cfg.spanDays ?? 120) * DAY;
  const asOf = start + spanMs;
  const idSeed = cfg.idSeed ?? `${cfg.seed}:ids`;
  const perApp = Math.ceil(cfg.events / apps.length);

  const all = [];
  const records = [];
  const stats = {
    invalid: { count: 0, byReason: {} },
    duplicateDeliveries: 0,
    corrections: 0,
    supersededOriginals: 0,
  };
  let appliedEvents = 0;

  for (const app of apps) {
    for (const p of app.processes) if (!PROCESSES[p]) throw new Error(`unknown process ${p}`);
    const ctx = createContext({
      appId: app.appId,
      process: app.processes[0],
      idSeed: cfg.distinctIds ? `${idSeed}:${app.appId}` : idSeed,
      asOf,
    });
    const g = { ctx, rng: createRng(`${cfg.seed}:${app.appId}:structure`), builders: [] };
    let root = 0;
    while (ctx.count < perApp) {
      ctx.process = app.processes[root % app.processes.length];
      const def = PROCESSES[ctx.process].kinds[PROCESSES[ctx.process].root];
      runEntity(g, def, {
        // Arrivals skew recent, so some work is always still in its first stage at the horizon.
        start: start + Math.round((1 - g.rng.float() ** 1.5) * 0.98 * spanMs),
        deadline: Number.POSITIVE_INFINITY,
        ancestors: [],
        relations: [],
        attributes: def.attrs ? def.attrs(g.rng, 0) : {},
      });
      root++;
    }
    for (const b of g.builders) {
      const rec = b.record();
      if (rec) all.push(rec);
      appliedEvents += b.version;
    }
    const nrng = createRng(`${cfg.seed}:${app.appId}:delivery`);
    for (const d of deliveries(g, profile, nrng, stats)) records.push(d);
  }

  // Receipt order = delivery order; ties keep generation order.
  records.forEach((r, i) => {
    r.seq = i;
  });
  records.sort((a, b) => a.recv - b.recv || a.seq - b.seq);
  const lines = records.map((r) => ({ receivedAt: toIso(r.recv), event: r.event }));

  all.sort((a, b) => cmp(a.appId, b.appId) || cmp(a.kind, b.kind) || cmp(a.id, b.id));
  const truth = {
    asOf: toIso(asOf),
    totals: {
      deliveries: lines.length,
      invalid: {
        count: stats.invalid.count,
        byReason: Object.fromEntries(
          Object.entries(stats.invalid.byReason).sort(([a], [b]) => cmp(a, b)),
        ),
      },
      duplicateDeliveries: stats.duplicateDeliveries,
      duplicateConflicts: 0,
      corrections: stats.corrections,
      supersededOriginals: stats.supersededOriginals,
      appliedEvents,
    },
    apps: summarize(all, asOf),
  };
  return {
    records: lines,
    entities: all,
    truth,
    params: {
      ...cfg,
      apps,
      profile: cfg.profile ?? "default",
      start: toIso(start),
      spanDays: spanMs / DAY,
      idSeed,
    },
  };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export { PROCESS_NAMES };
