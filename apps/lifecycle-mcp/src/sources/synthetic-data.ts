import type { CaseSummary, IntervalState, TimelineEntry, WorkflowDefinition } from "../source";

/**
 * Deterministic, entirely invented lifecycle data for tests and local demos: change rollouts,
 * support tickets, and the two acceptance domains (a recruiting interview-loop hierarchy and a
 * service rollout with regional child deployments). Opaque ids and declared categorical values
 * only; no people, names, scores, notes or free text. The same seed always yields the same cases,
 * so sample responses are stable.
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

/** The recruiting acceptance app: an invented hiring pipeline, categorical fields only. */
export const RECRUITING_APP = "synthetic-recruiting";
/** The delivery acceptance app: an invented service rollout with regional child deployments. */
export const DELIVERY_APP = "synthetic-delivery";

const roleFamily = {
  key: "role_family",
  label: "Role family",
  values: ["engineering", "operations", "design"],
};
const loopFormat = {
  key: "loop_format",
  label: "Loop format",
  values: ["virtual", "onsite", "hybrid"],
};
const serviceTier = {
  key: "service_tier",
  label: "Service tier",
  values: ["tier1", "tier2", "tier3"],
};
const RECRUITING_PUBLISHED = Date.UTC(2026, 2, 1);

const HEADCOUNT_V1: WorkflowDefinition = {
  workflow_key: "headcount-request",
  version: 1,
  label: "Headcount request",
  description: "A request for one budgeted position, from request to approval.",
  stages: [
    stage("requested", "Requested", 1),
    stage("approval", "Approval", 2),
    stage("approved", "Approved", 3, true),
  ],
  outcomes: ["approved", "rejected", "cancelled"],
  dimensions: [roleFamily],
  published_at: RECRUITING_PUBLISHED,
};

const REQUISITION_V1: WorkflowDefinition = {
  workflow_key: "requisition",
  version: 1,
  label: "Requisition",
  description: "An approved opening from posting to filled; it may pause (on_hold) and resume.",
  stages: [
    stage("opened", "Opened", 1),
    stage("sourcing", "Sourcing", 2),
    stage("interviewing", "Interviewing", 3),
    stage("on_hold", "On hold", 4),
    stage("filled", "Filled", 5, true),
  ],
  outcomes: ["filled", "closed_unfilled", "cancelled"],
  dimensions: [roleFamily],
  published_at: RECRUITING_PUBLISHED,
};

const APPLICATION_V1: WorkflowDefinition = {
  workflow_key: "application",
  version: 1,
  label: "Application",
  description:
    "One application to a requisition. withdrawn is the applicant leaving; cancelled is the requisition closing.",
  stages: [
    stage("applied", "Applied", 1),
    stage("screen", "Screen", 2),
    stage("interview_loop", "Interview loop", 3),
    stage("offer", "Offer", 4),
    stage("hired", "Hired", 5, true),
  ],
  outcomes: ["hired", "rejected", "withdrawn", "cancelled"],
  dimensions: [roleFamily],
  published_at: RECRUITING_PUBLISHED,
};

const INTERVIEW_LOOP_V1: WorkflowDefinition = {
  workflow_key: "interview-loop",
  version: 1,
  label: "Interview loop",
  description:
    "Define, staff, schedule, conduct three parallel assessment tracks, wait for scorecards, debrief and decide.",
  stages: [
    stage("defined", "Defined", 1),
    stage("staffing", "Staffing", 2),
    stage("scheduling", "Scheduling", 3),
    stage("on_hold", "On hold", 4),
    stage("conducting", "Conducting", 5),
    stage("feedback", "Feedback (scorecard wait)", 6),
    stage("debrief", "Debrief", 7),
    stage("decided", "Decided", 8, true),
  ],
  outcomes: ["advance", "reject", "withdrawn", "cancelled"],
  dimensions: [roleFamily, loopFormat],
  published_at: RECRUITING_PUBLISHED,
};

const ASSESSMENT_V1: WorkflowDefinition = {
  workflow_key: "assessment",
  version: 1,
  label: "Assessment track",
  description:
    "One of three parallel tracks of an interview loop. A no-show is rescheduled once (repeated visit).",
  stages: [
    stage("scheduled", "Scheduled", 1),
    stage("interview", "Interview", 2),
    stage("scorecard_pending", "Scorecard pending", 3),
    stage("submitted", "Scorecard submitted", 4, true),
  ],
  outcomes: ["submitted", "cancelled"],
  dimensions: [
    { key: "track", label: "Track", values: ["skills", "collaboration", "domain"] },
    loopFormat,
  ],
  published_at: RECRUITING_PUBLISHED,
};

const SERVICE_ROLLOUT_V1: WorkflowDefinition = {
  workflow_key: "service-rollout",
  version: 1,
  label: "Service rollout",
  description: "A release rolled out region by region; it may pause between regions or roll back.",
  stages: [
    stage("planned", "Planned", 1),
    stage("build", "Build", 2),
    stage("verify", "Verify", 3),
    stage("rolling_out", "Rolling out", 4),
    stage("paused", "Paused", 5),
    stage("completed", "Completed", 6, true),
  ],
  outcomes: ["succeeded", "rolled_back", "cancelled"],
  dimensions: [serviceTier],
  published_at: Date.UTC(2026, 4, 1),
};

const SERVICE_ROLLOUT_V2: WorkflowDefinition = {
  ...SERVICE_ROLLOUT_V1,
  version: 2,
  description: "Version 2 adds an automated bake gate before the regional rollout.",
  stages: [
    stage("planned", "Planned", 1),
    stage("build", "Build", 2),
    stage("verify", "Verify", 3),
    stage("bake", "Automated bake", 4),
    stage("rolling_out", "Rolling out", 5),
    stage("paused", "Paused", 6),
    stage("completed", "Completed", 7, true),
  ],
  published_at: Date.UTC(2026, 7, 15),
};

const REGIONS = ["us-east", "eu-west", "ap-south", "us-west"] as const;

const REGIONAL_DEPLOYMENT_V1: WorkflowDefinition = {
  workflow_key: "regional-deployment",
  version: 1,
  label: "Regional deployment",
  description:
    "One region of a service rollout. A failed canary is retried once; a second failure rolls back.",
  stages: [
    stage("queued", "Queued", 1),
    stage("canary", "Canary", 2),
    stage("ramping", "Ramping", 3),
    stage("verified", "Verified", 4, true),
  ],
  outcomes: ["succeeded", "rolled_back", "skipped", "cancelled"],
  dimensions: [{ key: "region", label: "Region", values: [...REGIONS] }, serviceTier],
  published_at: Date.UTC(2026, 4, 1),
};

export const SYNTHETIC_WORKFLOWS: SyntheticWorkflow[] = [
  { appId: "synthetic-release", definition: ROLLOUT_V1 },
  { appId: "synthetic-release", definition: ROLLOUT_V2 },
  { appId: "synthetic-support", definition: SUPPORT_V1 },
  // A second app with the same workflow and no default grant: for cross-app denial checks.
  { appId: "synthetic-restricted", definition: SUPPORT_V1 },
  ...[HEADCOUNT_V1, REQUISITION_V1, APPLICATION_V1, INTERVIEW_LOOP_V1, ASSESSMENT_V1].map(
    (definition) => ({ appId: RECRUITING_APP, definition }),
  ),
  ...[SERVICE_ROLLOUT_V1, SERVICE_ROLLOUT_V2, REGIONAL_DEPLOYMENT_V1].map((definition) => ({
    appId: DELIVERY_APP,
    definition,
  })),
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

/**
 * Parent/child links of the acceptance domains. Fixture-only: `LifecycleReadSource` exposes no
 * relation graph, so the MCP tools never see these and refuse `dependency_scope:
 * child_dependencies`. Tests use them to show what that refusal is withholding.
 */
export type SyntheticRelation = {
  appId: string;
  relation: "child_of";
  parent_case_id: string;
  child_case_id: string;
  /** The parent stage that waits on the child. */
  parent_stage: string;
};

/** Loops that start at or after this instant get slower scorecards: the planted regression. */
export const SCORECARD_REGRESSION_AT = Date.UTC(2026, 8, 1);

/** Records a complete timeline with explicit interval states; `seal` applies the anchor later. */
class Track {
  intervals: TimelineEntry[] = [];
  private attempts = new Map<string, number>();

  constructor(
    readonly start: number,
    public t: number = start,
  ) {}

  visit(stageKey: string, ms: number, state: IntervalState = "completed"): this {
    const attempt = (this.attempts.get(stageKey) ?? 0) + 1;
    this.attempts.set(stageKey, attempt);
    const exit = this.t + Math.max(0, Math.round(ms));
    this.intervals.push({
      stage_key: stageKey,
      attempt,
      state,
      entered_at: this.t,
      exited_at: exit,
    });
    this.t = exit;
    return this;
  }

  /** Ends the timeline at `at` (withdrawal, cancellation): later intervals are dropped. */
  stopAt(at: number): this {
    this.intervals = this.intervals.flatMap((i) => {
      if (i.entered_at >= at) return [];
      if ((i.exited_at ?? at) <= at) return [i];
      return [{ ...i, state: "interrupted" as const, exited_at: at }];
    });
    this.t = Math.min(this.t, at);
    return this;
  }
}

type Built = { cases: SyntheticCase[]; relations: SyntheticRelation[] };

/** Turns a complete timeline into what the read model would hold at the synthetic anchor. */
function seal(
  appId: string,
  caseId: string,
  def: WorkflowDefinition,
  dims: Record<string, string>,
  track: Track,
  outcome: string,
): SyntheticCase | null {
  if (track.start >= SYNTHETIC_ANCHOR) return null;
  const intervals = track.intervals
    .filter((i) => i.entered_at < SYNTHETIC_ANCHOR)
    .map((i) =>
      (i.exited_at ?? 0) > SYNTHETIC_ANCHOR
        ? { ...i, state: "active" as const, exited_at: null }
        : i,
    );
  const closed = track.t < SYNTHETIC_ANCHOR;
  const last = intervals[intervals.length - 1];
  return {
    appId,
    case_id: caseId,
    workflow_key: def.workflow_key,
    version: def.version,
    status: closed ? "closed" : "open",
    outcome: closed ? outcome : null,
    current_stage: closed ? null : (last?.stage_key ?? null),
    started_at: track.start,
    ended_at: closed ? track.t : null,
    last_event_at: intervals.reduce(
      (max, i) => Math.max(max, i.exited_at ?? i.entered_at),
      track.start,
    ),
    dimensions: dims,
    intervals,
  };
}

function ids(rng: Rng, tag: string) {
  let n = 0;
  return () => {
    const suffix = Math.floor(rng() * 0xffffff)
      .toString(16)
      .padStart(6, "0");
    return `c_${tag}_${(n++).toString(36).padStart(4, "0")}${suffix}`;
  };
}

function collect(out: Built, c: SyntheticCase | null, parent?: [string, string]) {
  if (!c) return;
  out.cases.push(c);
  if (parent) {
    out.relations.push({
      appId: c.appId,
      relation: "child_of",
      parent_case_id: parent[0],
      child_case_id: c.case_id,
      parent_stage: parent[1],
    });
  }
}

const TRACKS = ["skills", "collaboration", "domain"] as const;
/** Loop indexes forced onto the rare `hybrid` format, to exercise small-cell suppression. */
const HYBRID_LOOPS = new Set([11, 47, 90]);

type Hold = { start: number; end: number };

/**
 * One interview loop and its three parallel assessment tracks. The loop waits in `conducting`
 * until the last track is interviewed and in `feedback` until the last scorecard lands.
 */
function interviewLoop(rng: Rng, start: number, hold: Hold | null, cancelAt: number | null) {
  const loop = new Track(start);
  loop.visit("defined", dwell(rng, 4, 0.5)).visit("staffing", dwell(rng, 20, 0.6));
  const created = loop.t;
  const scheduling = dwell(rng, 30, 0.6);
  if (hold && loop.t < hold.end && loop.t + scheduling > hold.start) {
    // The requisition paused mid-scheduling: interrupted, on hold, then a second attempt.
    const pauseAt = Math.max(loop.t, hold.start);
    const done = pauseAt - loop.t;
    loop.visit("scheduling", done, "interrupted").visit("on_hold", hold.end - pauseAt);
    loop.visit("scheduling", scheduling - done);
  } else {
    loop.visit("scheduling", scheduling);
  }
  const confirmed = loop.t;
  const slow = start >= SCORECARD_REGRESSION_AT;
  const tracks = TRACKS.map((track) => {
    const a = new Track(created);
    a.visit("scheduled", confirmed - created + rng() * 2 * DAY);
    if (rng() < 0.06) {
      // No-show: the interview is interrupted and the track is rescheduled once.
      a.visit("interview", HOUR, "interrupted").visit("scheduled", dwell(rng, 40, 0.5));
    }
    a.visit("interview", dwell(rng, 1, 0.2));
    const interviewed = a.t;
    a.visit("scorecard_pending", dwell(rng, slow ? 40 : 10, 0.7)).visit("submitted", 0);
    return { track, a, interviewed };
  });
  const conducted = Math.max(...tracks.map((t) => t.interviewed));
  const scored = Math.max(...tracks.map((t) => t.a.t));
  loop.visit("conducting", conducted - confirmed).visit("feedback", scored - conducted);
  loop.visit("debrief", dwell(rng, 18, 0.5));
  let outcome = rng() < 0.45 ? "advance" : "reject";
  loop.visit("decided", 0);
  const withdrawAt = rng() < 0.07 ? created + rng() * (loop.t - created) : null;
  const stop = [withdrawAt, cancelAt]
    .filter((at): at is number => at !== null && at < loop.t)
    .sort((a, b) => a - b)[0];
  const outcomes = tracks.map(() => "submitted");
  if (stop !== undefined) {
    outcome = stop === withdrawAt ? "withdrawn" : "cancelled";
    loop.stopAt(stop);
    tracks.forEach((t, i) => {
      if (t.a.t > stop) {
        t.a.stopAt(stop);
        outcomes[i] = "cancelled";
      }
    });
  }
  return { loop, outcome, tracks, outcomes };
}

function recruiting(): Built {
  const rng = prng(41);
  const out: Built = { cases: [], relations: [] };
  const next = ids(rng, "rc");
  let loopIndex = 0;
  for (let r = 0; r < 42; r++) {
    const role = pick(rng, roleFamily.values, [5, 3, 2]);
    const roleDims = { role_family: role };
    const headcount = new Track(Math.round(SYNTHETIC_ANCHOR - 175 * DAY + rng() * 160 * DAY));
    headcount.visit("requested", dwell(rng, 8)).visit("approval", dwell(rng, 48, 0.8));
    const headcountId = next();
    if (rng() < 0.1) {
      collect(
        out,
        seal(RECRUITING_APP, headcountId, HEADCOUNT_V1, roleDims, headcount, "rejected"),
      );
      continue;
    }
    headcount.visit("approved", 0);
    collect(out, seal(RECRUITING_APP, headcountId, HEADCOUNT_V1, roleDims, headcount, "approved"));

    const req = new Track(headcount.t);
    const reqId = next();
    req.visit("opened", dwell(rng, 4)).visit("sourcing", dwell(rng, 5 * 24, 0.4));
    const interviewing = req.t;
    const hold =
      rng() < 0.15
        ? (() => {
            const start = interviewing + (3 + rng() * 20) * DAY;
            return { start, end: start + dwell(rng, 6 * 24, 0.4) };
          })()
        : null;
    const cancelAt = rng() < 0.07 ? interviewing + (5 + rng() * 25) * DAY : null;
    const appCount = 10 + Math.floor(rng() * 5);
    let reqEnd = interviewing;
    let filled = false;
    for (let j = 0; j < appCount; j++) {
      const arrival = interviewing - 2 * DAY + rng() * 30 * DAY;
      if (cancelAt !== null && arrival >= cancelAt) continue;
      const app = new Track(Math.round(arrival));
      const appId = next();
      app.visit("applied", dwell(rng, 24)).visit("screen", dwell(rng, 60, 0.7));
      let appOutcome: string;
      const u = rng();
      if (u < 0.32) appOutcome = "rejected";
      else if (u < 0.4) appOutcome = "withdrawn";
      else {
        const loopDims = {
          role_family: role,
          loop_format: HYBRID_LOOPS.has(loopIndex)
            ? "hybrid"
            : pick(rng, ["virtual", "onsite"], [3, 2]),
        };
        loopIndex++;
        const { loop, outcome, tracks, outcomes } = interviewLoop(rng, app.t, hold, cancelAt);
        const loopId = next();
        collect(out, seal(RECRUITING_APP, loopId, INTERVIEW_LOOP_V1, loopDims, loop, outcome), [
          appId,
          "interview_loop",
        ]);
        tracks.forEach((t, i) => {
          const trackDims = { track: t.track, loop_format: loopDims.loop_format };
          collect(
            out,
            seal(RECRUITING_APP, next(), ASSESSMENT_V1, trackDims, t.a, outcomes[i] ?? "submitted"),
            [loopId, "conducting"],
          );
        });
        app.visit("interview_loop", loop.t - app.t);
        appOutcome = { advance: "offer", reject: "rejected" }[outcome] ?? outcome;
        if (appOutcome === "offer") {
          app.visit("offer", dwell(rng, 72, 0.5));
          appOutcome = rng() < 0.8 ? "hired" : "withdrawn";
          if (appOutcome === "hired") app.visit("hired", 0);
        }
      }
      if (cancelAt !== null && app.t > cancelAt && appOutcome !== "cancelled") {
        app.stopAt(cancelAt);
        appOutcome = "cancelled";
      }
      filled ||= appOutcome === "hired";
      reqEnd = Math.max(reqEnd, app.t);
      collect(out, seal(RECRUITING_APP, appId, APPLICATION_V1, roleDims, app, appOutcome), [
        reqId,
        "interviewing",
      ]);
    }
    if (hold && hold.start < reqEnd) {
      req
        .visit("interviewing", hold.start - req.t, "interrupted")
        .visit("on_hold", hold.end - hold.start);
    }
    req.visit("interviewing", Math.max(0, reqEnd - req.t));
    const reqOutcome = filled ? "filled" : cancelAt !== null ? "cancelled" : "closed_unfilled";
    if (filled) req.visit("filled", 0);
    collect(out, seal(RECRUITING_APP, reqId, REQUISITION_V1, roleDims, req, reqOutcome), [
      headcountId,
      "approved",
    ]);
  }
  return out;
}

/** A rollout and its regional children; regions run in sequence and may pause in between. */
function delivery(): Built {
  const rng = prng(51);
  const out: Built = { cases: [], relations: [] };
  const next = ids(rng, "dl");
  const specs = [
    { def: SERVICE_ROLLOUT_V1, count: 130, startDays: [120, 30], canaryFail: 0.14 },
    { def: SERVICE_ROLLOUT_V2, count: 130, startDays: [75, 0], canaryFail: 0.05 },
  ] as const;
  for (const spec of specs) {
    const [fromDays, toDays] = spec.startDays;
    for (let i = 0; i < spec.count; i++) {
      const start = Math.round(
        SYNTHETIC_ANCHOR - fromDays * DAY + rng() * (fromDays - toDays) * DAY,
      );
      const tier = [5, 77].includes(i) ? "tier3" : pick(rng, ["tier1", "tier2"], [2, 3]);
      const ro = new Track(start);
      const roId = next();
      ro.visit("planned", dwell(rng, 3, 0.6)).visit("build", dwell(rng, 0.4, 0.4));
      ro.visit("verify", dwell(rng, 0.7, 0.4));
      if (rng() < 0.08) {
        // Verification failed: rebuild and verify again (repeated visits).
        ro.visit("build", dwell(rng, 0.4, 0.4)).visit("verify", dwell(rng, 0.7, 0.4));
      }
      if (spec.def.version === 2) ro.visit("bake", dwell(rng, 1.5, 0.3));
      const regions = REGIONS.slice(0, tier === "tier1" ? 4 : 3);
      const pauseAfterFirst = rng() < 0.1;
      let segment = ro.t;
      let rolledBack = false;
      const children: { region: string; t: Track; outcome: string }[] = [];
      for (const [j, region] of regions.entries()) {
        const child = new Track(ro.t);
        if (rolledBack) {
          child.visit("queued", 0, "skipped");
          children.push({ region, t: child, outcome: "skipped" });
          continue;
        }
        child.visit("queued", dwell(rng, 0.2, 0.8)).visit("canary", dwell(rng, 0.5, 0.4));
        let outcome = "succeeded";
        if (rng() < spec.canaryFail) {
          // A failed canary is retried once; a second failure rolls the region back.
          child.visit("canary", dwell(rng, 0.5, 0.4));
          if (rng() < 0.5) outcome = "rolled_back";
        }
        if (outcome === "succeeded")
          child.visit("ramping", dwell(rng, 2, 0.5)).visit("verified", 0);
        children.push({ region, t: child, outcome });
        ro.t = child.t;
        rolledBack = outcome === "rolled_back";
        if (j === 0 && pauseAfterFirst && !rolledBack) {
          const now = ro.t;
          ro.t = segment;
          ro.visit("rolling_out", now - segment, "interrupted").visit("paused", dwell(rng, 6, 0.6));
          segment = ro.t;
        }
      }
      const regionEnd = ro.t;
      ro.t = segment;
      ro.visit("rolling_out", regionEnd - segment);
      let outcome = rolledBack ? "rolled_back" : "succeeded";
      if (!rolledBack) ro.visit("completed", 0);
      if (rng() < 0.03) {
        ro.stopAt(start + rng() * (ro.t - start));
        outcome = "cancelled";
      }
      collect(out, seal(DELIVERY_APP, roId, spec.def, { service_tier: tier }, ro, outcome));
      for (const c of children) {
        if (outcome === "cancelled" && c.t.start >= ro.t) continue;
        let childOutcome = c.outcome;
        if (outcome === "cancelled" && c.t.t > ro.t) {
          c.t.stopAt(ro.t);
          childOutcome = "cancelled";
        }
        collect(
          out,
          seal(
            DELIVERY_APP,
            next(),
            REGIONAL_DEPLOYMENT_V1,
            { region: c.region, service_tier: tier },
            c.t,
            childOutcome,
          ),
          [roId, "rolling_out"],
        );
      }
    }
  }
  return out;
}

let cache: { cases: SyntheticCase[]; relations: SyntheticRelation[] } | null = null;

function all() {
  if (!cache) {
    const domains = [recruiting(), delivery()];
    cache = {
      cases: [...SPECS.flatMap(generate), ...domains.flatMap((d) => d.cases)],
      relations: domains.flatMap((d) => d.relations),
    };
  }
  return cache;
}

/** All synthetic cases, generated once per isolate. */
export function syntheticCases(): SyntheticCase[] {
  return all().cases;
}

/** Fixture-only parent/child links; see `SyntheticRelation`. */
export function syntheticRelations(): SyntheticRelation[] {
  return all().relations;
}
