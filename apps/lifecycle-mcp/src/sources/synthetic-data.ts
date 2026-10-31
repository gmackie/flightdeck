import type { CaseSummary, TimelineEntry, WorkflowDefinition } from "../source";

/**
 * Deterministic, entirely invented lifecycle data for tests and local demos. Generic domains only
 * (change rollout, support tickets); no people, names, notes or free text. The same seed always
 * yields the same cases, so sample responses are stable.
 */

/** Data ends here: the synthetic watermark. */
export const SYNTHETIC_ANCHOR = Date.UTC(2026, 9, 30);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type SyntheticCase = CaseSummary & { appId: string; intervals: TimelineEntry[] };

export type SyntheticWorkflow = { appId: string; definition: WorkflowDefinition };

const stage = (key: string, label: string, order: number, terminal = false) => ({
  key,
  label,
  order,
  terminal,
});

const rolloutDims = [
  { key: "service_tier", label: "Service tier", values: ["tier1", "tier2", "tier3"] },
  { key: "change_size", label: "Change size", values: ["small", "medium", "large"] },
];

const ROLLOUT_V1: WorkflowDefinition = {
  workflow_key: "change-rollout",
  version: 1,
  label: "Change rollout",
  description: "A code or config change from proposal to full release.",
  stages: [
    stage("proposed", "Proposed", 1),
    stage("review", "Review", 2),
    stage("build", "Build", 3),
    stage("staging", "Staging soak", 4),
    stage("canary", "Canary", 5),
    stage("released", "Released", 6, true),
  ],
  outcomes: ["released", "rolled_back", "abandoned"],
  dimensions: rolloutDims,
  published_at: Date.UTC(2026, 5, 1),
};

const ROLLOUT_V2: WorkflowDefinition = {
  ...ROLLOUT_V1,
  version: 2,
  description: "Version 2 adds automated checks before human review.",
  stages: [
    stage("proposed", "Proposed", 1),
    stage("automated_checks", "Automated checks", 2),
    stage("review", "Review", 3),
    stage("build", "Build", 4),
    stage("staging", "Staging soak", 5),
    stage("canary", "Canary", 6),
    stage("released", "Released", 7, true),
  ],
  published_at: Date.UTC(2026, 7, 15),
};

const SUPPORT_V1: WorkflowDefinition = {
  workflow_key: "support-ticket",
  version: 1,
  label: "Support ticket",
  description: "A customer support request from intake to resolution.",
  stages: [
    stage("new", "New", 1),
    stage("triage", "Triage", 2),
    stage("in_progress", "In progress", 3),
    stage("waiting_on_requester", "Waiting on requester", 4),
    stage("resolved", "Resolved", 5, true),
  ],
  outcomes: ["resolved", "auto_closed", "escalated"],
  dimensions: [
    { key: "channel", label: "Channel", values: ["email", "chat", "web", "phone"] },
    { key: "priority", label: "Priority", values: ["p1", "p2", "p3"] },
  ],
  published_at: Date.UTC(2026, 4, 1),
};

export const SYNTHETIC_WORKFLOWS: SyntheticWorkflow[] = [
  { appId: "synthetic-release", definition: ROLLOUT_V1 },
  { appId: "synthetic-release", definition: ROLLOUT_V2 },
  { appId: "synthetic-support", definition: SUPPORT_V1 },
  // A second app with the same workflow and no default grant: for cross-app denial checks.
  { appId: "synthetic-restricted", definition: SUPPORT_V1 },
];

/** mulberry32: small, fast and deterministic. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Rng = ReturnType<typeof prng>;

/** Log-normal duration around `medianHours`. */
function dwell(rng: Rng, medianHours: number, sigma = 0.6): number {
  const u = Math.max(rng(), 1e-9);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  return Math.round(Math.exp(Math.log(medianHours * HOUR) + sigma * z));
}

function pick<T>(rng: Rng, values: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < values.length; i++) {
    r -= weights[i] ?? 0;
    if (r <= 0) return values[i] as T;
  }
  return values[values.length - 1] as T;
}

/** Records stage visits until the walk ends or the anchor cuts it off (an open case). */
class Walk {
  intervals: TimelineEntry[] = [];
  private attempts = new Map<string, number>();
  open = false;

  constructor(public t: number) {}

  /** Spends `ms` in `stageKey`. Returns false once the anchor is reached. */
  visit(stageKey: string, ms: number): boolean {
    if (this.open) return false;
    const attempt = (this.attempts.get(stageKey) ?? 0) + 1;
    this.attempts.set(stageKey, attempt);
    const exit = this.t + ms;
    if (exit > SYNTHETIC_ANCHOR) {
      this.intervals.push({
        stage_key: stageKey,
        attempt,
        state: "active",
        entered_at: this.t,
        exited_at: null,
      });
      this.open = true;
      return false;
    }
    this.intervals.push({
      stage_key: stageKey,
      attempt,
      state: "completed",
      entered_at: this.t,
      exited_at: exit,
    });
    this.t = exit;
    return true;
  }
}

function rolloutCase(rng: Rng, version: 1 | 2, dims: Record<string, string>, start: number) {
  const walk = new Walk(start);
  const sizeFactor = dims.change_size === "large" ? 1.8 : dims.change_size === "small" ? 0.7 : 1;
  const canaryFactor = dims.service_tier === "tier1" ? 2 : 1;
  const outcome = ((): string | null => {
    if (!walk.visit("proposed", dwell(rng, 4))) return null;
    if (version === 2) {
      if (!walk.visit("automated_checks", dwell(rng, 0.5, 0.4))) return null;
      if (rng() < 0.12) {
        if (!walk.visit("proposed", dwell(rng, 3))) return null;
        if (!walk.visit("automated_checks", dwell(rng, 0.5, 0.4))) return null;
      }
    }
    const reviewHours = (version === 1 ? 30 : 10) * sizeFactor;
    if (!walk.visit("review", dwell(rng, reviewHours, 0.9))) return null;
    if (rng() < 0.08) {
      return "abandoned";
    }
    if (!walk.visit("build", dwell(rng, 2, 0.4))) return null;
    if (rng() < (version === 1 ? 0.14 : 0.06)) {
      if (!walk.visit("review", dwell(rng, reviewHours * 0.5, 0.7))) return null;
      if (!walk.visit("build", dwell(rng, 2, 0.4))) return null;
    }
    if (!walk.visit("staging", dwell(rng, 20, 0.3))) return null;
    if (!walk.visit("canary", dwell(rng, 8 * canaryFactor, 0.5))) return null;
    if (rng() < 0.07) {
      return "rolled_back";
    }
    walk.visit("released", 0);
    return "released";
  })();
  return { walk, outcome };
}

function supportCase(rng: Rng, dims: Record<string, string>, start: number) {
  const walk = new Walk(start);
  const triageHours = (dims.priority === "p1" ? 0.6 : 3) * (dims.channel === "chat" ? 0.5 : 1);
  const outcome = ((): string | null => {
    if (!walk.visit("new", dwell(rng, 0.5, 0.5))) return null;
    if (!walk.visit("triage", dwell(rng, triageHours, 0.7))) return null;
    // A long tail of tickets stalls on the requester for weeks, so recent cohorts stay open.
    if (rng() < 0.2) {
      if (!walk.visit("in_progress", dwell(rng, 4, 0.5))) return null;
      if (!walk.visit("waiting_on_requester", dwell(rng, 21 * 24, 0.5))) return null;
    }
    for (let loop = 0; ; loop++) {
      if (!walk.visit("in_progress", dwell(rng, 10, 0.8))) return null;
      if (loop >= 2 || rng() >= 0.35) break;
      if (!walk.visit("waiting_on_requester", dwell(rng, 26, 0.9))) return null;
      if (rng() < 0.15) {
        return "auto_closed";
      }
    }
    if (rng() < 0.08) {
      return "escalated";
    }
    walk.visit("resolved", 0);
    return "resolved";
  })();
  return { walk, outcome };
}

type Spec = {
  appId: string;
  tag: string;
  definition: WorkflowDefinition;
  count: number;
  /** Start times spread over [anchor - from days, anchor - to days). */
  startDays: [number, number];
  seed: number;
  /** Case indexes forced onto a rare dimension value, to exercise suppression. */
  rare: { key: string; value: string; indexes: number[] };
};

const SPECS: Spec[] = [
  {
    appId: "synthetic-release",
    tag: "r1",
    definition: ROLLOUT_V1,
    count: 150,
    startDays: [120, 30],
    seed: 11,
    rare: { key: "service_tier", value: "tier3", indexes: [7, 64, 121] },
  },
  {
    appId: "synthetic-release",
    tag: "r2",
    definition: ROLLOUT_V2,
    count: 150,
    startDays: [75, 0],
    seed: 12,
    rare: { key: "service_tier", value: "tier3", indexes: [3, 90] },
  },
  {
    appId: "synthetic-support",
    tag: "s1",
    definition: SUPPORT_V1,
    count: 220,
    startDays: [100, 0],
    seed: 21,
    rare: { key: "channel", value: "phone", indexes: [10, 150] },
  },
  {
    appId: "synthetic-restricted",
    tag: "x1",
    definition: SUPPORT_V1,
    count: 60,
    startDays: [80, 0],
    seed: 31,
    rare: { key: "channel", value: "phone", indexes: [] },
  },
];

function generate(spec: Spec): SyntheticCase[] {
  const rng = prng(spec.seed);
  const cases: SyntheticCase[] = [];
  const [fromDays, toDays] = spec.startDays;
  for (let i = 0; i < spec.count; i++) {
    const start = Math.round(SYNTHETIC_ANCHOR - fromDays * DAY + rng() * (fromDays - toDays) * DAY);
    const dims: Record<string, string> = {};
    if (spec.definition.workflow_key === "change-rollout") {
      dims.service_tier = pick(rng, ["tier1", "tier2"], [2, 3]);
      dims.change_size = pick(rng, ["small", "medium", "large"], [5, 3, 2]);
    } else {
      dims.channel = pick(rng, ["email", "chat", "web"], [4, 3, 3]);
      dims.priority = pick(rng, ["p1", "p2", "p3"], [1, 3, 6]);
    }
    if (spec.rare.indexes.includes(i)) dims[spec.rare.key] = spec.rare.value;
    const { walk, outcome } =
      spec.definition.workflow_key === "change-rollout"
        ? rolloutCase(rng, spec.definition.version as 1 | 2, dims, start)
        : supportCase(rng, dims, start);
    const last = walk.intervals[walk.intervals.length - 1];
    const closed = !walk.open && outcome !== null;
    const suffix = Math.floor(rng() * 0xffffff)
      .toString(16)
      .padStart(6, "0");
    cases.push({
      appId: spec.appId,
      case_id: `c_${spec.tag}_${i.toString(36).padStart(3, "0")}${suffix}`,
      workflow_key: spec.definition.workflow_key,
      version: spec.definition.version,
      status: closed ? "closed" : "open",
      outcome: closed ? outcome : null,
      current_stage: closed ? null : (last?.stage_key ?? null),
      started_at: start,
      ended_at: closed ? walk.t : null,
      last_event_at: last ? (last.exited_at ?? last.entered_at) : start,
      dimensions: dims,
      intervals: walk.intervals,
    });
  }
  return cases;
}

let cache: SyntheticCase[] | null = null;

/** All synthetic cases, generated once per isolate. */
export function syntheticCases(): SyntheticCase[] {
  cache ??= SPECS.flatMap(generate);
  return cache;
}
