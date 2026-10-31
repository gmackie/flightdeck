// Hand-built scenarios. Each is small enough to read, and its `expected` block is written out by
// hand (not derived from the reducer), so it is an independent statement of the right answer.
import { createContext, EntityBuilder } from "./builder.mjs";
import { breakEvent } from "./generate.mjs";
import { INVALID_REASONS } from "./model.mjs";
import { createRng } from "./prng.mjs";
import { DAY as D, HOUR as H, MINUTE as M, parseIso, toIso } from "./util.mjs";

export const SCENARIO_SCHEMA = "flightdeck.lifecycle-fixture/v1";
const T0 = parseIso("2026-03-02T09:00:00.000Z");

const mk = (appId, process, name) => createContext({ appId, process, idSeed: `scenario:${name}` });
const E = (ctx, kind) => new EntityBuilder(ctx, kind);
const child = (kind, b) => ({ type: "child_of", kind, id: b.id });

/** Enter, dwell and exit each [stage, duration, exitOutcome] in turn. Returns the end time. */
function walk(b, t, steps) {
  for (const [name, dur, outcome] of steps) {
    b.enter(name, t);
    t += dur;
    b.exit(name, outcome, t);
  }
  return t;
}

/** open + walk + close a leaf entity. Returns its end time. */
function leaf(b, start, opts, steps, outcome) {
  b.open(start, opts);
  const end = walk(b, start, steps);
  b.close(outcome, end);
  return end;
}

/**
 * need > requisition > candidate > interview_loop down to `upTo`, ancestors left in the stage that
 * spawns the next level. The `upTo` entity is opened but not yet in a stage.
 */
function recruitingChain(ctx, t, upTo) {
  const kinds = ["headcount_need", "requisition", "candidate", "interview_loop"];
  const out = {};
  const all = [];
  let parent = null;
  for (const kind of kinds) {
    const b = E(ctx, kind);
    b.open(t, parent ? { relations: [child(parent.kind, parent)] } : {});
    out[kind] = b;
    all.push(b);
    if (kind === upTo) return { ...out, all, t };
    if (kind === "headcount_need") {
      t = walk(b, t, [["pending_approval", D, "advanced"]]);
      b.enter("approved", t);
    } else if (kind === "requisition") {
      t = walk(b, t, [["sourcing", D, "advanced"]]);
      b.enter("interviewing", t);
    } else {
      t = walk(b, t, [
        ["applied", D, "advanced"],
        ["screen", D, "advanced"],
      ]);
      b.enter("interview_loop", t);
    }
    parent = b;
  }
  return { ...out, all, t };
}

const events = (...builders) => builders.flatMap((b) => b.events).sort((a, b) => a.ts - b.ts);

/** In-order delivery, one second after occurrence unless `recv` says otherwise. */
const deliver = (evs, recv = (e) => e.ts + 1000) =>
  evs.map((e) => ({ receivedAt: toIso(recv(e)), event: e.event }));

const scenario = (name, description, covers, asOf, records, expected, extra = {}) => ({
  schema: SCENARIO_SCHEMA,
  name,
  description,
  covers,
  ...extra,
  asOf: toIso(asOf),
  records,
  expected,
});

function recruitingPipeline() {
  const name = "recruiting-pipeline";
  const ctx = mk("app_talent", "recruiting", name);
  const [need, req, c1, c2, c3, l1, l3, a1, a2] = [
    "headcount_need",
    "requisition",
    "candidate",
    "candidate",
    "candidate",
    "interview_loop",
    "interview_loop",
    "assessment",
    "assessment",
  ].map((k) => E(ctx, k));

  need.open(T0);
  let t = walk(need, T0, [["pending_approval", 2 * D, "advanced"]]);
  need.enter("approved", t);
  req.open(t, { relations: [child("headcount_need", need)] });
  const reqRel = [child("requisition", req)];
  t = walk(req, t, [["sourcing", 5 * D, "advanced"]]);
  req.enter("interviewing", t);

  // c1 is hired: day 8 -> 18d2h. Two concurrent assessments, one delayed scorecard.
  c1.open(T0 + 8 * D, { relations: reqRel });
  let ct = walk(c1, T0 + 8 * D, [
    ["applied", D, "advanced"],
    ["screen", 2 * D, "advanced"],
  ]);
  c1.enter("interview_loop", ct);
  l1.open(ct, { relations: [child("candidate", c1)] });
  const lt = walk(l1, ct, [["scheduling", D, "advanced"]]);
  l1.enter("in_progress", lt);
  const lrel = [child("interview_loop", l1)];
  const e1 = leaf(
    a1,
    lt,
    { relations: lrel, attributes: { type: "technical" } },
    [
      ["scheduled", D, "advanced"],
      ["interview", H, "advanced"],
      ["scorecard_pending", 8 * H, "completed"],
    ],
    "pass",
  );
  const e2 = leaf(
    a2,
    lt + H,
    { relations: lrel, attributes: { type: "behavioral" } },
    [
      ["scheduled", D, "advanced"],
      ["interview", H, "advanced"],
      ["scorecard_pending", 2 * D, "completed"],
    ],
    "pass",
  );
  const inProgressEnd = Math.max(e1, e2);
  l1.exit("in_progress", "advanced", inProgressEnd);
  const debriefEnd = walk(l1, inProgressEnd, [["debrief", D, "completed"]]);
  l1.close("advance", debriefEnd);
  c1.exit("interview_loop", "advanced", debriefEnd);
  const c1End = walk(c1, debriefEnd, [["offer", 2 * D, "completed"]]);
  c1.close("hired", c1End);

  // c2 is rejected at screen.
  c2.open(T0 + 9 * D, { relations: reqRel });
  ct = walk(c2, T0 + 9 * D, [
    ["applied", D, "advanced"],
    ["screen", 3 * D, "terminated"],
  ]);
  c2.close("rejected", ct);

  // c3 withdraws when its interview loop is cancelled while scheduling.
  c3.open(T0 + 10 * D, { relations: reqRel });
  ct = walk(c3, T0 + 10 * D, [
    ["applied", D, "advanced"],
    ["screen", 2 * D, "advanced"],
  ]);
  c3.enter("interview_loop", ct);
  l3.open(ct, { relations: [child("candidate", c3)] });
  const l3End = walk(l3, ct, [["scheduling", D, "terminated"]]);
  l3.close("cancelled", l3End);
  c3.exit("interview_loop", "terminated", l3End);
  c3.close("withdrawn", l3End);

  const reqEnd = T0 + 20 * D;
  req.exit("interviewing", "completed", reqEnd);
  req.close("filled", reqEnd);
  need.exit("approved", "completed", reqEnd + H);
  need.close("filled", reqEnd + H);

  const evs = events(need, req, c1, c2, c3, l1, l3, a1, a2);
  return scenario(
    name,
    "Hiring need to requisition to three candidates: one hired, one rejected at screen, one withdrawn when the loop is cancelled. Two assessments run concurrently with a delayed scorecard.",
    [
      "recruiting",
      "concurrent",
      "terminal:rejected",
      "terminal:withdrawn",
      "terminal:cancelled",
      "delayed_scorecard",
    ],
    T0 + 60 * D,
    deliver(evs),
    {
      totals: { invalid: { count: 0 }, appliedEvents: evs.length },
      entities: [
        { id: c1.id, status: "closed", outcome: "hired" },
        { id: c2.id, status: "closed", outcome: "rejected" },
        { id: c3.id, status: "closed", outcome: "withdrawn" },
        { id: need.id, status: "closed", outcome: "filled" },
      ],
      apps: {
        app_talent: {
          processes: ["recruiting"],
          entities: {
            headcount_need: { total: 1, outcomes: { filled: 1 } },
            requisition: { total: 1, outcomes: { filled: 1 } },
            candidate: {
              total: 3,
              status: { open: 0, paused: 0, closed: 3 },
              outcomes: { hired: 1, rejected: 1, withdrawn: 1 },
            },
            interview_loop: { total: 2, outcomes: { advance: 1, cancelled: 1 } },
            assessment: { total: 2, outcomes: { pass: 2 }, peakConcurrentPerParent: 2 },
          },
          stages: {
            "candidate/screen": {
              entered: 3,
              exited: 3,
              open: 0,
              outcomes: { advanced: 2, terminated: 1 },
              closedDwell: {
                count: 3,
                sumMs: 7 * D,
                minMs: 2 * D,
                maxMs: 3 * D,
                p50Ms: 2 * D,
                p95Ms: 3 * D,
              },
            },
            "assessment/scorecard_pending": {
              closedDwell: { count: 2, sumMs: 8 * H + 2 * D, minMs: 8 * H, maxMs: 2 * D },
            },
            "headcount_need/approved": { closedDwell: { count: 1, sumMs: 18 * D + H } },
          },
          relations: { child_of: 8 },
        },
      },
    },
  );
}

function recruitingPendingAndCancelled() {
  const name = "recruiting-pending-and-cancelled";
  const ctx = mk("app_talent", "recruiting", name);
  const asOf = T0 + 60 * D;
  const [na, nb, nc, rc, cc] = [
    "headcount_need",
    "headcount_need",
    "headcount_need",
    "requisition",
    "candidate",
  ].map((k) => E(ctx, k));

  // Still waiting for approval, six days in.
  na.open(asOf - 6 * D);
  na.enter("pending_approval", asOf - 6 * D);
  // Rejected after four days.
  nb.open(T0 + D);
  nb.close("rejected", walk(nb, T0 + D, [["pending_approval", 4 * D, "terminated"]]));
  // Approved, then cancelled on day 14: the whole subtree is closed `cancelled` beneath it.
  nc.open(T0 + 3 * D);
  let t = walk(nc, T0 + 3 * D, [["pending_approval", D, "advanced"]]);
  nc.enter("approved", t);
  rc.open(t, { relations: [child("headcount_need", nc)] });
  t = walk(rc, t, [["sourcing", 2 * D, "advanced"]]);
  rc.enter("interviewing", t);
  cc.open(T0 + 7 * D, { relations: [child("requisition", rc)] });
  cc.enter("applied", T0 + 7 * D);
  const cancelAt = T0 + 14 * D;
  cc.exit("applied", "terminated", cancelAt - 20);
  cc.close("cancelled", cancelAt - 20);
  rc.exit("interviewing", "terminated", cancelAt - 10);
  rc.close("cancelled", cancelAt - 10);
  nc.exit("approved", "terminated", cancelAt);
  nc.close("cancelled", cancelAt);

  const evs = events(na, nb, nc, rc, cc);
  return scenario(
    name,
    "One need still pending approval, one rejected, one cancelled mid-flight with its requisition and candidate cancelled beneath it.",
    ["recruiting", "pending_approval", "terminal:rejected", "terminal:cancelled"],
    asOf,
    deliver(evs),
    {
      totals: { appliedEvents: evs.length },
      entities: [
        { id: na.id, status: "open", outcome: null },
        { id: nb.id, status: "closed", outcome: "rejected" },
        { id: nc.id, status: "closed", outcome: "cancelled" },
        { id: cc.id, status: "closed", outcome: "cancelled" },
      ],
      apps: {
        app_talent: {
          entities: {
            headcount_need: {
              total: 3,
              status: { open: 1, paused: 0, closed: 2 },
              outcomes: { cancelled: 1, rejected: 1 },
            },
            requisition: { total: 1, outcomes: { cancelled: 1 } },
            candidate: { total: 1, outcomes: { cancelled: 1 } },
          },
          stages: {
            "headcount_need/pending_approval": {
              entered: 3,
              exited: 2,
              open: 1,
              outcomes: { advanced: 1, terminated: 1 },
              openDwell: { count: 1, sumMs: 6 * D, maxMs: 6 * D },
            },
          },
        },
      },
    },
  );
}

function recruitingRepeatAssessment() {
  const name = "recruiting-repeat-assessment-delayed-scorecard";
  const ctx = mk("app_talent", "recruiting", name);
  const chain = recruitingChain(ctx, T0, "interview_loop");
  const { interview_loop: loop, t } = chain;
  loop.enter("in_progress", t);
  const [a1, a2] = [E(ctx, "assessment"), E(ctx, "assessment")];
  const rel = [child("interview_loop", loop)];
  // Attempt 1: the candidate does not show up.
  a1.open(t, { relations: rel, attributes: { type: "technical" } });
  const e1 = walk(a1, t, [
    ["scheduled", D, "advanced"],
    ["interview", 2 * H, "terminated"],
  ]);
  a1.close("no_show", e1);
  // Attempt 2 supersedes it; the scorecard lands nine days after the interview.
  const s2 = e1 + D;
  a2.open(s2, {
    relations: [...rel, { type: "supersedes", kind: "assessment", id: a1.id }],
    attributes: { type: "technical", attempt: 2 },
  });
  const e2 = walk(a2, s2, [
    ["scheduled", 2 * D, "advanced"],
    ["interview", H, "advanced"],
    ["scorecard_pending", 9 * D, "completed"],
  ]);
  a2.close("pass", e2);

  const evs = events(...chain.all, a1, a2);
  return scenario(
    name,
    "A no-show assessment is retaken as attempt 2 (supersedes attempt 1); the retake's scorecard is submitted nine days late.",
    ["recruiting", "repeated_assessment", "delayed_scorecard", "terminal:no_show"],
    T0 + 60 * D,
    deliver(evs),
    {
      totals: { appliedEvents: evs.length },
      entities: [
        { id: a1.id, status: "closed", outcome: "no_show" },
        {
          id: a2.id,
          status: "closed",
          outcome: "pass",
          attributes: { type: "technical", attempt: 2 },
        },
      ],
      apps: {
        app_talent: {
          entities: { assessment: { total: 2, outcomes: { no_show: 1, pass: 1 } } },
          stages: {
            "assessment/scorecard_pending": {
              closedDwell: { count: 1, sumMs: 9 * D, maxMs: 9 * D },
            },
            "assessment/interview": { outcomes: { advanced: 1, terminated: 1 } },
          },
          relations: { supersedes: 1 },
        },
      },
    },
  );
}

function recruitingPausedReopened() {
  const name = "recruiting-paused-reopened";
  const ctx = mk("app_talent", "recruiting", name);
  const chain = recruitingChain(ctx, T0, "requisition");
  const { requisition: req, t } = chain;
  // Sourcing is paused for twenty days (budget freeze), so the stage dwells 22 days.
  req.enter("sourcing", t);
  req.pause(t + D);
  req.resume(t + 21 * D);
  req.exit("sourcing", "advanced", t + 22 * D);
  const e1 = walk(req, t + 22 * D, [["interviewing", 3 * D, "completed"]]);
  req.close("filled", e1);
  // The hire falls through: the requisition is reopened and closes unfilled.
  const r = e1 + 5 * D;
  req.reopen(r);
  const e2 = walk(req, r, [["sourcing", 4 * D, "completed"]]);
  req.close("closed_unfilled", e2);

  const evs = events(...chain.all);
  return scenario(
    name,
    "A requisition is paused for 20 days mid-stage, closes filled, is reopened, and finally closes unfilled.",
    ["recruiting", "paused", "reopened", "long_dwell"],
    T0 + 60 * D,
    deliver(evs),
    {
      totals: { appliedEvents: evs.length },
      entities: [
        {
          id: req.id,
          status: "closed",
          outcome: "closed_unfilled",
          reopenCount: 1,
          pausedMs: 20 * D,
          pausedSince: null,
        },
      ],
      apps: {
        app_talent: {
          entities: {
            requisition: {
              total: 1,
              reopenedEntities: 1,
              reopenEvents: 1,
              pausedMsTotal: 20 * D,
              outcomes: { closed_unfilled: 1 },
            },
          },
          stages: {
            "requisition/sourcing": {
              entered: 2,
              exited: 2,
              open: 0,
              closedDwell: { count: 2, sumMs: 26 * D, minMs: 4 * D, maxMs: 22 * D },
            },
          },
        },
      },
    },
  );
}

function serviceRegionalRollouts() {
  const name = "service-regional-rollouts";
  const ctx = mk("app_platform", "service_delivery", name);
  const svc = E(ctx, "service");
  svc.open(T0, { attributes: { tier: "customer_facing" } });
  const t = walk(svc, T0, [
    ["scaffolding", D, "advanced"],
    ["provisioning", 2 * D, "advanced"],
  ]);
  svc.enter("live", t);
  const svcRel = [child("service", svc)];

  const [d1, d2, r1, r2, r3, r4, r5] = [
    "deployment",
    "deployment",
    ...Array(5).fill("regional_rollout"),
  ].map((k) => E(ctx, k));
  const d1s = T0 + 10 * D;
  d1.open(d1s, { relations: svcRel });
  const d1r = walk(d1, d1s, [
    ["build", 10 * M, "advanced"],
    ["verify", 20 * M, "advanced"],
  ]);
  d1.enter("rolling_out", d1r);
  const rel1 = [child("deployment", d1)];
  const ends = [
    leaf(
      r1,
      d1r + M,
      { relations: rel1, attributes: { region: "us-east" } },
      [
        ["queued", 5 * M, "advanced"],
        ["canary", 30 * M, "advanced"],
        ["ramping", H, "completed"],
      ],
      "succeeded",
    ),
    leaf(
      r2,
      d1r + 2 * M,
      { relations: rel1, attributes: { region: "eu-west" } },
      [
        ["queued", 5 * M, "advanced"],
        ["canary", 20 * M, "terminated"],
      ],
      "failed",
    ),
    leaf(
      r3,
      d1r + 3 * M,
      { relations: rel1, attributes: { region: "ap-south" } },
      [
        ["queued", 5 * M, "advanced"],
        ["canary", 30 * M, "advanced"],
        ["ramping", 40 * M, "terminated"],
      ],
      "rolled_back",
    ),
  ];
  const d1e = Math.max(...ends) + M;
  d1.exit("rolling_out", "terminated", d1e);
  d1.close("rolled_back", d1e);

  const d2s = T0 + 20 * D;
  d2.open(d2s, { relations: svcRel });
  const d2r = walk(d2, d2s, [
    ["build", 10 * M, "advanced"],
    ["verify", 20 * M, "advanced"],
  ]);
  d2.enter("rolling_out", d2r);
  const rel2 = [child("deployment", d2)];
  const steps = [
    ["queued", 5 * M, "advanced"],
    ["canary", 30 * M, "advanced"],
    ["ramping", H, "completed"],
  ];
  const ends2 = [
    leaf(r4, d2r + M, { relations: rel2, attributes: { region: "us-east" } }, steps, "succeeded"),
    leaf(
      r5,
      d2r + 2 * M,
      { relations: rel2, attributes: { region: "eu-west" } },
      steps,
      "succeeded",
    ),
  ];
  const d2e = Math.max(...ends2) + M;
  d2.exit("rolling_out", "completed", d2e);
  d2.close("succeeded", d2e);

  const evs = events(svc, d1, d2, r1, r2, r3, r4, r5);
  return scenario(
    name,
    "A live service with two deployments. The first rolls out to three regions at once (success, failure, rollback) and is rolled back; the second succeeds in two regions.",
    ["service_delivery", "concurrent", "terminal:rolled_back", "terminal:failed"],
    T0 + 60 * D,
    deliver(evs),
    {
      totals: { appliedEvents: evs.length },
      entities: [
        { id: d1.id, status: "closed", outcome: "rolled_back" },
        { id: d2.id, status: "closed", outcome: "succeeded" },
        { id: svc.id, status: "open", outcome: null },
      ],
      apps: {
        app_platform: {
          processes: ["service_delivery"],
          entities: {
            service: { total: 1, status: { open: 1, paused: 0, closed: 0 } },
            deployment: {
              total: 2,
              outcomes: { rolled_back: 1, succeeded: 1 },
              peakConcurrentPerParent: 1,
            },
            regional_rollout: {
              total: 5,
              outcomes: { failed: 1, rolled_back: 1, succeeded: 3 },
              peakConcurrentPerParent: 3,
            },
          },
          stages: {
            "service/live": {
              entered: 1,
              open: 1,
              openDwell: { count: 1, sumMs: 57 * D, maxMs: 57 * D },
            },
          },
        },
      },
    },
  );
}

function incidentRemediationReopen() {
  const name = "incident-remediation-reopen";
  const ctx = mk("app_support", "incident_response", name);
  const [k, i1, i2, r1] = ["ticket", "investigation", "investigation", "remediation"].map((x) =>
    E(ctx, x),
  );
  k.open(T0, { attributes: { severity: "sev2" } });
  const t = walk(k, T0, [["triage", 15 * M, "advanced"]]);
  k.enter("investigating", t);
  k.enter("customer_comms", t + 30 * M); // runs in parallel with `investigating`
  const kRel = [child("ticket", k)];

  // i1 finds the root cause; its remediation r1 is also related_to the ticket.
  const i1s = t + 5 * M;
  i1.open(i1s, { relations: kRel });
  const i1a = walk(i1, i1s, [
    ["open", 10 * M, "advanced"],
    ["analyzing", 2 * H, "advanced"],
  ]);
  i1.enter("remediation", i1a);
  const r1End = leaf(
    r1,
    i1a + 5 * M,
    { relations: [child("investigation", i1), { type: "related_to", kind: "ticket", id: k.id }] },
    [
      ["planned", 20 * M, "advanced"],
      ["implementing", H, "advanced"],
      ["verifying", 30 * M, "completed"],
    ],
    "fixed",
  );
  i1.exit("remediation", "completed", r1End + M);
  i1.close("root_cause_found", r1End + M);

  // i2 runs alongside and is inconclusive.
  const i2s = t + 10 * M;
  i2.open(i2s, { relations: kRel });
  const i2End = walk(i2, i2s, [
    ["open", 5 * M, "advanced"],
    ["analyzing", 3 * H, "terminated"],
  ]);
  i2.close("inconclusive", i2End);

  const invEnd = Math.max(r1End + M, i2End) + M;
  k.exit("customer_comms", "completed", invEnd);
  k.exit("investigating", "advanced", invEnd);
  const kEnd = walk(k, invEnd, [["monitoring", D, "completed"]]);
  k.close("resolved", kEnd);
  // Reopened three days later; resolved again two hours on.
  const ro = kEnd + 3 * D;
  k.reopen(ro);
  k.enter("investigating", ro);
  k.exit("investigating", "completed", ro + 2 * H);
  k.close("resolved", ro + 2 * H);

  const evs = events(k, i1, i2, r1);
  return scenario(
    name,
    "A ticket runs two investigations in parallel (one finds the root cause and spawns a fix, one is inconclusive), keeps a customer-comms stage open alongside its main stage, resolves, then is reopened and resolved again.",
    ["incident_response", "concurrent", "reopened", "parallel_stages"],
    T0 + 60 * D,
    deliver(evs),
    {
      totals: { appliedEvents: evs.length },
      entities: [
        {
          id: k.id,
          status: "closed",
          outcome: "resolved",
          reopenCount: 1,
          attributes: { severity: "sev2" },
        },
      ],
      apps: {
        app_support: {
          processes: ["incident_response"],
          entities: {
            ticket: {
              total: 1,
              reopenedEntities: 1,
              reopenEvents: 1,
              parallelStageEntities: 1,
              outcomes: { resolved: 1 },
            },
            investigation: {
              total: 2,
              outcomes: { inconclusive: 1, root_cause_found: 1 },
              peakConcurrentPerParent: 2,
            },
            remediation: { total: 1, outcomes: { fixed: 1 } },
          },
          stages: {
            "ticket/investigating": { entered: 2, exited: 2, open: 0 },
            "ticket/customer_comms": { entered: 1, exited: 1 },
          },
          relations: { child_of: 3, related_to: 1 },
        },
      },
    },
  );
}

function incidentLongDwellOpen() {
  const name = "incident-long-dwell-open";
  const ctx = mk("app_support", "incident_response", name);
  const asOf = T0 + 90 * D;
  const [k1, k2] = [E(ctx, "ticket"), E(ctx, "ticket")];
  // k1 has been investigating for 45 days.
  k1.open(asOf - 46 * D);
  const t1 = walk(k1, asOf - 46 * D, [["triage", D, "advanced"]]);
  k1.enter("investigating", t1);
  // k2 has been investigating for 40 days and has been paused (waiting on the customer) for 30.
  k2.open(asOf - 41 * D);
  const t2 = walk(k2, asOf - 41 * D, [["triage", D, "advanced"]]);
  k2.enter("investigating", t2);
  k2.pause(asOf - 30 * D);

  const evs = events(k1, k2);
  return scenario(
    name,
    "Two tickets still open at the as-of time: one has dwelled 45 days in investigating, the other 40 days and is currently paused for the last 30.",
    ["incident_response", "long_dwell", "paused", "open_at_horizon"],
    asOf,
    deliver(evs),
    {
      totals: { appliedEvents: evs.length },
      entities: [
        { id: k1.id, status: "open" },
        { id: k2.id, status: "paused", pausedMs: 0, pausedSince: asOf - 30 * D },
      ],
      apps: {
        app_support: {
          entities: {
            ticket: { total: 2, status: { open: 1, paused: 1, closed: 0 }, pausedMsTotal: 30 * D },
          },
          stages: {
            "ticket/investigating": {
              entered: 2,
              open: 2,
              openDwell: { count: 2, sumMs: 85 * D, maxMs: 45 * D },
            },
          },
        },
      },
    },
  );
}

function deliveryOutOfOrder() {
  const name = "delivery-out-of-order-and-late";
  const ctx = mk("app_support", "incident_response", name);
  const k = E(ctx, "ticket");
  k.open(T0);
  walk(k, T0, [["triage", D, "advanced"]]);
  k.enter("investigating", T0 + D);
  k.exit("investigating", "advanced", T0 + 2 * D);
  k.enter("monitoring", T0 + 2 * D);
  k.exit("monitoring", "completed", T0 + 3 * D);
  k.close("resolved", T0 + 3 * D);
  // versions: 1 opened, 2/3 triage, 4/5 investigating, 6/7 monitoring, 8 closed
  const ev = Object.fromEntries(k.events.map((e) => [e.event.version, e]));
  const t6 = ev[8].ts;
  // Delivery order by version: 1 2 3 8 7 4 6 5. The final close lands first; the middle is late.
  const order = [
    [1, ev[1].ts + 1000],
    [2, ev[2].ts + 1000],
    [3, ev[3].ts + 1000],
    [8, t6 + 10_000],
    [7, t6 + 2 * H],
    [4, t6 + 3 * H],
    [6, t6 + D],
    [5, t6 + 2 * D],
  ];
  const records = order.map(([v, recv]) => ({ receivedAt: toIso(recv), event: ev[v].event }));
  return scenario(
    name,
    "One ticket's history arrives scrambled and late (close first, middle events a day or two behind). The reduced state ignores arrival order.",
    ["late_delivery", "out_of_order"],
    T0 + 30 * D,
    records,
    {
      totals: { appliedEvents: 8, invalid: { count: 0 } },
      entities: [
        {
          id: k.id,
          status: "closed",
          outcome: "resolved",
          version: 8,
          openedAt: T0,
          closedAt: T0 + 3 * D,
        },
      ],
      apps: {
        app_support: { stages: { "ticket/triage": { closedDwell: { count: 1, sumMs: D } } } },
      },
      delivery: { outOfOrderDeliveries: 4, lateEvents: 4 },
    },
  );
}

function duplicatesAndCorrections() {
  const name = "duplicates-and-corrections";
  const ctx = mk("app_support", "incident_response", name);
  const k = E(ctx, "ticket");
  k.open(T0);
  k.enter("triage", T0);
  k.exit("triage", "advanced", T0 + 10 * M);
  k.enter("investigating", T0 + 10 * M);
  k.exit("investigating", "completed", T0 + H);
  k.close("resolved", T0 + H);
  const byV = Object.fromEntries(k.events.map((e) => [e.event.version, e]));
  const mkId = createRng(`scenario:${name}:extra`);
  const fix = (v, patch) => ({
    ...structuredClone(byV[v].event),
    ...patch,
    eventId: mkId.id(),
    corrects: byV[v].event.eventId,
  });
  const wrong = (v, patch) => ({ ...structuredClone(byV[v].event), ...patch });
  const at = (v) => byV[v].ts;
  const R = (ts, event) => ({ receivedAt: toIso(ts), event });

  const wrongExit = wrong(3, { outcome: "terminated" }); // exit outcome wrong
  const wrongEnter = wrong(4, { occurredAt: toIso(at(4) + 5 * M) }); // timestamp wrong
  const wrongClose = wrong(6, { outcome: "cancelled" }); // final outcome wrong
  const records = [
    R(at(1) + 1000, byV[1].event),
    R(at(2) + 1000, byV[2].event),
    R(at(2) + 2000, byV[2].event), // exact duplicate redelivery
    R(at(3) + 1000, wrongExit),
    R(at(4) + 1000, wrongEnter),
    R(at(5) + 1000, byV[5].event),
    R(at(6) + 1000, fix(6, { outcome: "resolved" })), // the correction arrives before the original
    R(at(6) + 2000, wrongClose),
    R(at(6) + 3000, wrongClose), // duplicate of the wrong original
    R(at(6) + 5 * M, fix(3, { outcome: "advanced" })),
    R(at(6) + 6 * M, fix(4, { occurredAt: byV[4].event.occurredAt })),
  ];
  return scenario(
    name,
    "Exact redeliveries, and three corrections (wrong exit outcome, wrong timestamp, wrong final outcome) where one correction is delivered before the event it corrects.",
    ["duplicate_event_id", "correction", "out_of_order"],
    T0 + 30 * D,
    records,
    {
      totals: {
        deliveries: 11,
        duplicateDeliveries: 2,
        duplicateConflicts: 0,
        corrections: 3,
        supersededOriginals: 3,
        appliedEvents: 6,
        invalid: { count: 0 },
      },
      entities: [
        {
          id: k.id,
          status: "closed",
          outcome: "resolved",
          version: 6,
          stageInstances: [
            { name: "triage", enteredAt: T0, exitedAt: T0 + 10 * M, outcome: "advanced" },
            {
              name: "investigating",
              enteredAt: T0 + 10 * M,
              exitedAt: T0 + H,
              outcome: "completed",
            },
          ],
        },
      ],
    },
  );
}

function duplicateIdConflict() {
  const name = "duplicate-id-conflict";
  const ctx = mk("app_support", "incident_response", name);
  const k = E(ctx, "ticket");
  k.open(T0);
  k.close("resolved", T0 + H);
  const [open, close] = k.events.map((e) => e.event);
  const conflicting = { ...structuredClone(close), outcome: "cancelled" }; // same eventId, different payload
  return scenario(
    name,
    "A second delivery reuses an eventId with different content. Fixture semantics: the first delivery wins and the conflict is counted, not applied.",
    ["duplicate_event_id"],
    T0 + 30 * D,
    [
      { receivedAt: toIso(T0 + 1000), event: open },
      { receivedAt: toIso(T0 + H + 1000), event: close },
      { receivedAt: toIso(T0 + H + 2000), event: conflicting },
    ],
    {
      totals: { deliveries: 3, duplicateDeliveries: 0, duplicateConflicts: 1, appliedEvents: 2 },
      entities: [{ id: k.id, status: "closed", outcome: "resolved" }],
    },
    {
      assumptions: [
        "First delivery of an (appId, eventId) wins; later conflicting payloads are rejected and counted.",
      ],
    },
  );
}

function invalidEvents() {
  const name = "invalid-events";
  const ctx = mk("app_support", "incident_response", name);
  const k = E(ctx, "ticket");
  k.open(T0, { relations: [] });
  k.enter("triage", T0);
  k.exit("triage", "advanced", T0 + 10 * M);
  k.close("resolved", T0 + 10 * M);
  const clean = k.events.map((e) => e.event);
  const rng = createRng(`scenario:${name}:break`);
  const source = (reason) => {
    const want = {
      missing_stage: "stage.entered",
      unknown_stage: "stage.entered",
      missing_outcome: "stage.exited",
      unknown_outcome: "stage.exited",
      orphan_stage_exit: "stage.exited",
      self_relation: "entity.opened",
    }[reason];
    return clean.find((e) => e.type === (want ?? "entity.closed"));
  };
  const records = clean.map((e, i) => ({ receivedAt: toIso(T0 + i * 1000 + 1000), event: e }));
  const byReason = {};
  for (const reason of INVALID_REASONS) {
    const event =
      reason === "not_an_object" ? "garbage" : breakEvent(reason, source(reason), rng, ctx);
    records.push({ receivedAt: toIso(T0 + D), event });
    byReason[reason] = 1;
  }
  return scenario(
    name,
    "One valid ticket plus one event for every invalid reason. Each is rejected with its own reason code and has no effect on state.",
    ["invalid"],
    T0 + 30 * D,
    records,
    {
      totals: {
        deliveries: clean.length + INVALID_REASONS.length,
        invalid: { count: INVALID_REASONS.length, byReason },
        appliedEvents: clean.length,
      },
      entities: [{ id: k.id, status: "closed", outcome: "resolved", version: clean.length }],
      apps: { app_support: { entities: { ticket: { total: 1 } } } },
    },
  );
}

function appScopeSeparation() {
  const name = "app-scope-separation";
  // Both apps share an idSeed, so they mint identical event ids and entity ids on purpose.
  const mkApp = (appId, outcome) => {
    const ctx = createContext({
      appId,
      process: "recruiting",
      idSeed: "scenario:app-scope-separation",
    });
    const n = E(ctx, "headcount_need");
    n.open(T0);
    const end = walk(n, T0, [
      ["pending_approval", 2 * D, outcome === "filled" ? "advanced" : "terminated"],
    ]);
    if (outcome === "filled") {
      n.enter("approved", end);
      n.exit("approved", "completed", end + D);
      n.close("filled", end + D);
    } else n.close(outcome, end);
    return n;
  };
  const a = mkApp("app_talent", "filled");
  const b = mkApp("app_hiring2", "rejected");
  const records = [...a.events, ...b.events]
    .sort((x, y) => x.ts - y.ts)
    .map((e) => ({ receivedAt: toIso(e.ts + 1000), event: e.event }));
  return scenario(
    name,
    "Two apps reuse the same eventIds and entity id. Dedupe and entity identity are per app, so nothing collides and each app's numbers stand alone.",
    ["app_scope", "duplicate_event_id"],
    T0 + 30 * D,
    records,
    {
      totals: { duplicateDeliveries: 0, duplicateConflicts: 0, invalid: { count: 0 } },
      entities: [
        { appId: "app_talent", id: a.id, status: "closed", outcome: "filled" },
        { appId: "app_hiring2", id: b.id, status: "closed", outcome: "rejected" },
      ],
      apps: {
        app_talent: { entities: { headcount_need: { total: 1, outcomes: { filled: 1 } } } },
        app_hiring2: { entities: { headcount_need: { total: 1, outcomes: { rejected: 1 } } } },
      },
      scope: { eventIdsSharedAcrossApps: 4, entityIdsSharedAcrossApps: 1, isolated: true },
    },
  );
}

function brokenStateMachine() {
  const name = "broken-state-machine";
  const ctx = mk("app_support", "incident_response", name);
  const [x, y, z, p] = ["ticket", "ticket", "ticket", "ticket"].map((k) => E(ctx, k));
  // x: version 3 never arrives -> version gap.
  x.open(T0);
  x.pause(T0 + M);
  x.resume(T0 + 2 * M);
  x.close("resolved", T0 + 3 * M);
  // y: a stage is entered on a ticket that is already closed.
  y.open(T0);
  y.close("resolved", T0 + M);
  y.enter("triage", T0 + 2 * M);
  // z: version 2 claims to have occurred before version 1.
  z.open(T0 + H);
  z.enter("triage", T0 + H);
  z.events[1].event.occurredAt = toIso(T0);
  // p: paused twice without resuming.
  p.open(T0);
  p.pause(T0 + M);
  p.pause(T0 + 2 * M);
  const drop = x.events[2].event.eventId;
  const evs = events(x, y, z, p).filter((e) => e.event.eventId !== drop);
  return scenario(
    name,
    "Negative case: streams that break baseline invariants. The validator must report each violation code rather than accept them.",
    ["invariant_violations"],
    T0 + 30 * D,
    deliver(evs),
    { violations: ["pause_invalid", "stage_on_closed", "time_regression", "version_gap"] },
  );
}

export function buildScenarios() {
  return [
    recruitingPipeline(),
    recruitingPendingAndCancelled(),
    recruitingRepeatAssessment(),
    recruitingPausedReopened(),
    serviceRegionalRollouts(),
    incidentRemediationReopen(),
    incidentLongDwellOpen(),
    deliveryOutOfOrder(),
    duplicatesAndCorrections(),
    duplicateIdConflict(),
    invalidEvents(),
    appScopeSeparation(),
    brokenStateMachine(),
  ];
}
