// Late-ingestion simulation: how delivery time (receivedAt) diverges from occurrence time.
import { ID_RE } from "./model.mjs";
import { reduceRecords } from "./reduce.mjs";
import { ensure, HOUR, parseIso, percentile } from "./util.mjs";

const SEP = "\u0000";
const eventTime = (r) =>
  r && typeof r.event === "object" && r.event ? parseIso(r.event.occurredAt) : Number.NaN;

/**
 * Lag, lateness and out-of-order statistics for a delivery stream.
 * @param {{receivedAt: string, event: any}[]} records in delivery order
 */
export function deliveryReport(records, { lateAfterMs = HOUR } = {}) {
  const lags = [];
  const maxSeen = new Map();
  const outOfOrderEntities = new Set();
  let inversions = 0;
  let late = 0;
  let unparseable = 0;
  for (const r of records) {
    const occurred = eventTime(r);
    const received = parseIso(r.receivedAt);
    if (Number.isNaN(occurred) || Number.isNaN(received)) {
      unparseable++;
      continue;
    }
    const lag = received - occurred;
    lags.push(lag);
    if (lag > lateAfterMs) late++;
    const e = r.event;
    if (e.entity?.id !== undefined && Number.isInteger(e.version) && e.version < 100000) {
      const key = `${e.appId}${SEP}${e.entity.kind}${SEP}${e.entity.id}`;
      const prev = maxSeen.get(key) ?? 0;
      if (e.version < prev) {
        inversions++;
        outOfOrderEntities.add(key);
      } else maxSeen.set(key, e.version);
    }
  }
  lags.sort((a, b) => a - b);
  return {
    records: records.length,
    measured: lags.length,
    unparseable,
    lateAfterMs,
    lateEvents: late,
    lateRate: lags.length ? late / lags.length : 0,
    lagMs: {
      min: lags[0] ?? null,
      p50: percentile(lags, 0.5),
      p95: percentile(lags, 0.95),
      p99: percentile(lags, 0.99),
      max: lags[lags.length - 1] ?? null,
    },
    outOfOrderDeliveries: inversions,
    outOfOrderEntities: outOfOrderEntities.size,
  };
}

/**
 * Compare what a consumer knows at time T by delivery (receivedAt <= T) with what had actually
 * happened by T (occurredAt <= T). The gap is the cost of late ingestion; the last checkpoint
 * is after all deliveries and the two views must agree there.
 */
export function checkpointReport(records, { checkpoints = 6 } = {}) {
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const r of records) {
    const o = eventTime(r);
    const d = parseIso(r.receivedAt);
    if (!Number.isNaN(o)) first = Math.min(first, o);
    if (!Number.isNaN(d)) last = Math.max(last, d);
  }
  const rows = [];
  for (let i = 1; i <= checkpoints; i++) {
    const t = Math.round(first + ((last - first) * i) / checkpoints);
    const byDelivery = reduceRecords(
      records.filter((r) => parseIso(r.receivedAt) <= t),
      { asOf: t },
    );
    const byOccurrence = reduceRecords(
      records.filter((r) => eventTime(r) <= t),
      { asOf: t },
    );
    const closed = (red) => red.entities.filter((e) => e.status === "closed").length;
    const gaps = new Set(
      byDelivery.violations.filter((v) => v.code === "version_gap").map((v) => `${v.appId}${v.id}`),
    );
    rows.push({
      at: new Date(t).toISOString(),
      appliedByDelivery: byDelivery.totals.appliedEvents,
      appliedByOccurrence: byOccurrence.totals.appliedEvents,
      eventsStillInFlight: byOccurrence.totals.appliedEvents - byDelivery.totals.appliedEvents,
      entitiesByDelivery: byDelivery.entities.length,
      entitiesByOccurrence: byOccurrence.entities.length,
      closedByDelivery: closed(byDelivery),
      closedByOccurrence: closed(byOccurrence),
      entitiesWithVersionGaps: gaps.size,
    });
  }
  return rows;
}

/** App scope separation: ids reused across apps, and proof that each app reduces identically alone. */
export function scopeReport(records, { asOf } = {}) {
  const eventApps = new Map();
  const entityApps = new Map();
  const apps = new Set();
  for (const r of records) {
    const e = r?.event;
    if (!e || typeof e !== "object" || typeof e.appId !== "string" || !ID_RE.test(e.appId))
      continue;
    apps.add(e.appId);
    if (typeof e.eventId === "string") addTo(eventApps, e.eventId, e.appId);
    if (e.entity?.id) addTo(entityApps, e.entity.id, e.appId);
  }
  const whole = reduceRecords(records, { asOf });
  const mismatches = [];
  for (const appId of apps) {
    const alone = reduceRecords(
      records.filter((r) => r?.event?.appId === appId),
      { asOf: whole.asOf },
    );
    const a = JSON.stringify(alone.entities);
    const b = JSON.stringify(whole.entities.filter((e) => e.appId === appId));
    if (a !== b) mismatches.push(appId);
  }
  return {
    apps: [...apps].sort(),
    eventIdsSharedAcrossApps: [...eventApps.values()].filter((s) => s.size > 1).length,
    entityIdsSharedAcrossApps: [...entityApps.values()].filter((s) => s.size > 1).length,
    isolationMismatches: mismatches,
    isolated: mismatches.length === 0,
  };
}

function addTo(map, key, value) {
  ensure(map, key, () => new Set()).add(value);
}
