// Builds well-formed lifecycle events for one entity and tracks the simulation's own view of it.
// The generator and the hand-written scenarios both use this, so event shape lives in one place.
//
// Events past `ctx.asOf` are not emitted: the entity simply stays in whatever state it had reached
// ("cut"), exactly like a real process observed mid-flight.
import { createRng } from "./prng.mjs";
import { toIso } from "./util.mjs";

/**
 * @param {{ appId: string, process: string, idSeed: string, asOf?: number }} opts
 * Ids come from per-purpose streams seeded by `idSeed`, so two apps given the same `idSeed`
 * deliberately mint colliding ids (used to prove app scope separation).
 */
export function createContext({ appId, process, idSeed, asOf = Number.POSITIVE_INFINITY }) {
  const evt = createRng(`${idSeed}:evt`);
  const ent = createRng(`${idSeed}:ent`);
  const stg = createRng(`${idSeed}:stg`);
  return {
    appId,
    process,
    asOf,
    count: 0,
    newEventId: () => evt.id(),
    newEntityId: () => ent.id(),
    newStageId: () => stg.id(),
  };
}

export class EntityBuilder {
  constructor(ctx, kind, id = ctx.newEntityId()) {
    this.ctx = ctx;
    this.process = ctx.process;
    this.kind = kind;
    this.id = id;
    this.version = 0;
    this.lastTs = Number.NEGATIVE_INFINITY;
    this.cut = false;
    /** Emitted events in version order: `{ ts, event }`. */
    this.events = [];
    this.openStages = new Map();
    // The simulation's own record of the entity (the generator's ground truth).
    this.status = "new";
    this.outcome = null;
    this.openedAt = null;
    this.closedAt = null;
    this.reopenCount = 0;
    this.pausedMs = 0;
    this.pausedSince = null;
    this.relations = [];
    this.attributes = {};
    this.stageInstances = [];
  }

  emit(type, ts, extra = {}) {
    if (this.cut) return null;
    if (ts > this.ctx.asOf) {
      this.cut = true;
      return null;
    }
    if (ts < this.lastTs) {
      throw new Error(`non-monotonic ts on ${this.kind}/${this.id}: ${ts} < ${this.lastTs}`);
    }
    this.lastTs = ts;
    const event = {
      eventId: this.ctx.newEventId(),
      appId: this.ctx.appId,
      process: this.process,
      type,
      entity: { kind: this.kind, id: this.id },
      version: ++this.version,
      occurredAt: toIso(ts),
      ...extra,
    };
    this.events.push({ ts, event });
    this.ctx.count++;
    return event;
  }

  open(ts, { relations = [], attributes = {} } = {}) {
    const extra = {};
    if (relations.length) extra.relations = relations;
    if (Object.keys(attributes).length) extra.attributes = attributes;
    const ev = this.emit("entity.opened", ts, extra);
    if (!ev) return null;
    this.status = "open";
    this.openedAt = ts;
    this.relations = relations;
    this.attributes = attributes;
    return ev;
  }

  enter(name, ts) {
    const instanceId = this.ctx.newStageId();
    const ev = this.emit("stage.entered", ts, { stage: { name, instanceId } });
    if (!ev) return null;
    const inst = { id: instanceId, name, enteredAt: ts, exitedAt: null, outcome: null };
    this.stageInstances.push(inst);
    this.openStages.set(name, inst);
    return ev;
  }

  exit(name, outcome, ts) {
    const inst = this.openStages.get(name);
    if (!inst) return null;
    const ev = this.emit("stage.exited", ts, { stage: { name, instanceId: inst.id }, outcome });
    if (!ev) return null;
    inst.exitedAt = ts;
    inst.outcome = outcome;
    this.openStages.delete(name);
    return ev;
  }

  openStageNames() {
    return [...this.openStages.keys()];
  }

  pause(ts) {
    const ev = this.emit("entity.paused", ts);
    if (!ev) return null;
    this.status = "paused";
    this.pausedSince = ts;
    return ev;
  }

  resume(ts) {
    const ev = this.emit("entity.resumed", ts);
    if (!ev) return null;
    this.status = "open";
    this.pausedMs += ts - this.pausedSince;
    this.pausedSince = null;
    return ev;
  }

  close(outcome, ts) {
    const ev = this.emit("entity.closed", ts, { outcome });
    if (!ev) return null;
    if (this.pausedSince !== null) {
      this.pausedMs += ts - this.pausedSince;
      this.pausedSince = null;
    }
    this.status = "closed";
    this.outcome = outcome;
    this.closedAt = ts;
    return ev;
  }

  reopen(ts) {
    const ev = this.emit("entity.reopened", ts);
    if (!ev) return null;
    this.status = "open";
    this.outcome = null;
    this.closedAt = null;
    this.reopenCount++;
    return ev;
  }

  /** The simulation's record, or null when the entity never got opened within the horizon. */
  record() {
    if (this.version === 0) return null;
    return {
      appId: this.ctx.appId,
      process: this.process,
      kind: this.kind,
      id: this.id,
      version: this.version,
      status: this.status,
      outcome: this.outcome,
      openedAt: this.openedAt,
      closedAt: this.closedAt,
      reopenCount: this.reopenCount,
      pausedMs: this.pausedMs,
      pausedSince: this.pausedSince,
      relations: this.relations,
      attributes: this.attributes,
      stageInstances: this.stageInstances.map((s) => ({ ...s })),
    };
  }
}
