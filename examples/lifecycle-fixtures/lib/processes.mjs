// Three generic synthetic processes. Nothing here is real product, customer or HR/ops data.
//
// A kind is one object type in a hierarchy (need > requisition > candidate ...). Each kind runs
// through ordered stages. A stage may pause, spawn child entities, wait for them, and decide the
// entity's next step from their outcomes. `[median, sigma]` pairs are log-normal dwell times.
import { DAY, HOUR, MINUTE } from "./util.mjs";

// Every kind keeps `cancelled` in its vocabulary: a cancelled parent force-closes its open children.
/** Stage outcomes are shared by every kind; entity outcomes are per kind (`terminal`). */
export const STAGE_OUTCOMES = ["advanced", "completed", "terminated"];
export const RELATION_TYPES = ["child_of", "supersedes", "related_to"];

const REGIONS = ["us-east", "us-west", "eu-west", "eu-central", "ap-south", "ap-northeast"];

const recruiting = {
  root: "headcount_need",
  kinds: {
    headcount_need: {
      terminal: ["filled", "rejected", "cancelled"],
      final: [["filled", 1]],
      stages: [
        {
          name: "pending_approval",
          dwell: [2 * DAY, 0.9],
          advance: 0.88,
          exits: [
            ["rejected", 0.6],
            ["cancelled", 0.4],
          ],
          pause: { prob: 0.08, dwell: [6 * DAY, 0.6] },
        },
        {
          name: "approved",
          dwell: [3 * DAY, 0.7],
          abortProb: 0.06,
          spawn: { kind: "requisition", count: [1, 2], within: 0.3 },
          onChildren: (kids) => (kids.includes("filled") ? "next" : "cancelled"),
        },
      ],
    },
    requisition: {
      parent: "headcount_need",
      terminal: ["filled", "closed_unfilled", "cancelled"],
      final: [["filled", 1]],
      reopen: {
        prob: 0.08,
        stage: "sourcing",
        gap: [5 * DAY, 0.5],
        dwell: [8 * DAY, 0.6],
        outcomes: [
          ["filled", 0.7],
          ["closed_unfilled", 0.3],
        ],
      },
      stages: [
        {
          name: "sourcing",
          dwell: [5 * DAY, 0.7],
          advance: 0.96,
          exits: [["cancelled", 1]],
          pause: { prob: 0.1, dwell: [10 * DAY, 0.7] },
        },
        {
          name: "interviewing",
          dwell: [10 * DAY, 0.8],
          abortProb: 0.05,
          spawn: { kind: "candidate", count: [2, 4], within: 0.7 },
          onChildren: (kids) => (kids.includes("hired") ? "next" : "closed_unfilled"),
        },
      ],
    },
    candidate: {
      parent: "requisition",
      terminal: ["hired", "rejected", "withdrawn", "cancelled"],
      final: [["hired", 1]],
      reopen: {
        prob: 0.05,
        stage: "screen",
        gap: [3 * DAY, 0.5],
        dwell: [2 * DAY, 0.5],
        outcomes: [
          ["rejected", 0.5],
          ["withdrawn", 0.2],
          ["hired", 0.3],
        ],
      },
      stages: [
        {
          name: "applied",
          dwell: [1 * DAY, 0.8],
          advance: 0.9,
          exits: [
            ["rejected", 0.7],
            ["withdrawn", 0.3],
          ],
        },
        {
          name: "screen",
          dwell: [3 * DAY, 0.8],
          advance: 0.7,
          exits: [
            ["rejected", 0.65],
            ["withdrawn", 0.35],
          ],
        },
        {
          name: "interview_loop",
          dwell: [1 * DAY, 0.5],
          spawn: { kind: "interview_loop", count: [1, 1], within: 0 },
          onChildren: ([loop]) =>
            loop === "advance" ? "next" : loop === "cancelled" ? "withdrawn" : "rejected",
        },
        {
          name: "offer",
          dwell: [2 * DAY, 0.6],
          advance: 0.8,
          exits: [
            ["withdrawn", 0.6],
            ["rejected", 0.4],
          ],
        },
      ],
    },
    interview_loop: {
      parent: "candidate",
      terminal: ["advance", "reject", "cancelled"],
      final: [
        ["advance", 0.85],
        ["reject", 0.15],
      ],
      stages: [
        {
          name: "scheduling",
          dwell: [2 * DAY, 0.6],
          advance: 0.95,
          exits: [["cancelled", 1]],
        },
        {
          // Assessments run concurrently; a failed or no-show one may be retaken (repeated assessment).
          name: "in_progress",
          dwell: [1 * DAY, 0.4],
          spawn: {
            kind: "assessment",
            count: [2, 3],
            within: 0.5,
            retry: { when: ["no_show", "fail"], prob: 0.35, gap: [1 * DAY, 0.5] },
          },
          onChildren: (kids) => {
            if (kids.includes("fail")) return "reject";
            if (kids.includes("no_show") || kids.every((k) => k === "cancelled"))
              return "cancelled";
            return "next";
          },
        },
        { name: "debrief", dwell: [1 * DAY, 0.7] },
      ],
    },
    assessment: {
      parent: "interview_loop",
      terminal: ["pass", "fail", "no_show", "cancelled"],
      final: [
        ["pass", 0.68],
        ["fail", 0.32],
      ],
      attrs: (rng) => ({ type: rng.pick(["technical", "behavioral", "case", "system_design"]) }),
      stages: [
        {
          name: "scheduled",
          dwell: [3 * DAY, 0.6],
          advance: 0.94,
          exits: [["cancelled", 1]],
        },
        {
          name: "interview",
          dwell: [90 * MINUTE, 0.3],
          advance: 0.95,
          exits: [["no_show", 1]],
        },
        // Delayed scorecard: the interviewer's write-up often lands days late.
        { name: "scorecard_pending", dwell: [8 * HOUR, 0.9], tail: 0.15, tailMult: [10, 40] },
      ],
    },
  },
};

const serviceDelivery = {
  root: "service",
  kinds: {
    service: {
      terminal: ["retired", "failed_provisioning", "cancelled"],
      final: [["retired", 1]],
      attrs: (rng) => ({ tier: rng.pick(["internal", "customer_facing", "batch"]) }),
      stages: [
        {
          name: "scaffolding",
          dwell: [1 * DAY, 0.7],
          advance: 0.97,
          exits: [["cancelled", 1]],
        },
        {
          name: "provisioning",
          dwell: [2 * DAY, 0.8],
          advance: 0.94,
          exits: [
            ["failed_provisioning", 0.7],
            ["cancelled", 0.3],
          ],
          pause: { prob: 0.05, dwell: [5 * DAY, 0.7] },
        },
        {
          // Long-lived: most services are still live at the as-of time (long dwell).
          name: "live",
          dwell: [45 * DAY, 0.9],
          tail: 0.1,
          spawn: { kind: "deployment", count: [2, 5], within: 0.9 },
        },
      ],
    },
    deployment: {
      parent: "service",
      terminal: ["succeeded", "failed", "rolled_back", "cancelled"],
      final: [["succeeded", 1]],
      stages: [
        {
          name: "build",
          dwell: [12 * MINUTE, 0.5],
          advance: 0.93,
          exits: [["failed", 1]],
        },
        {
          name: "verify",
          dwell: [25 * MINUTE, 0.6],
          advance: 0.94,
          exits: [
            ["failed", 0.6],
            ["cancelled", 0.4],
          ],
        },
        {
          name: "rolling_out",
          dwell: [20 * MINUTE, 0.5],
          abortProb: 0.03,
          spawn: { kind: "regional_rollout", count: [2, 4], within: 0.1 },
          onChildren: (kids) => {
            if (kids.every((k) => k === "skipped")) return "cancelled";
            if (kids.includes("rolled_back")) return "rolled_back";
            if (kids.includes("failed")) return "failed";
            return "next";
          },
        },
      ],
    },
    regional_rollout: {
      parent: "deployment",
      terminal: ["succeeded", "failed", "rolled_back", "skipped", "cancelled"],
      final: [
        ["succeeded", 0.93],
        ["rolled_back", 0.07],
      ],
      attrs: (_rng, j) => ({ region: REGIONS[j % REGIONS.length] }),
      stages: [
        {
          name: "queued",
          dwell: [10 * MINUTE, 1.0],
          tail: 0.08,
          advance: 0.96,
          exits: [["skipped", 1]],
        },
        {
          name: "canary",
          dwell: [30 * MINUTE, 0.5],
          advance: 0.92,
          exits: [
            ["failed", 0.5],
            ["rolled_back", 0.5],
          ],
        },
        { name: "ramping", dwell: [2 * HOUR, 0.6] },
      ],
    },
  },
};

const incidentResponse = {
  root: "ticket",
  kinds: {
    ticket: {
      terminal: ["resolved", "duplicate", "cancelled", "wont_fix"],
      final: [["resolved", 1]],
      attrs: (rng) => ({ severity: rng.pick(["sev1", "sev2", "sev3", "sev4"]) }),
      // A side track runs on the same ticket in parallel with the main stage.
      side: { name: "customer_comms", from: "investigating", prob: 0.5 },
      reopen: {
        prob: 0.1,
        stage: "investigating",
        gap: [3 * DAY, 0.6],
        dwell: [6 * HOUR, 0.8],
        outcomes: [["resolved", 1]],
      },
      stages: [
        {
          name: "triage",
          dwell: [20 * MINUTE, 0.9],
          advance: 0.9,
          exits: [
            ["duplicate", 0.5],
            ["wont_fix", 0.3],
            ["cancelled", 0.2],
          ],
        },
        {
          name: "investigating",
          dwell: [3 * HOUR, 1.0],
          tail: 0.08,
          abortProb: 0.02,
          pause: { prob: 0.12, dwell: [2 * DAY, 0.8] },
          spawn: { kind: "investigation", count: [1, 2], within: 0.2 },
          onChildren: (kids) => (kids.every((k) => k === "abandoned") ? "wont_fix" : "next"),
        },
        { name: "monitoring", dwell: [1 * DAY, 0.8] },
      ],
    },
    investigation: {
      parent: "ticket",
      terminal: ["root_cause_found", "inconclusive", "abandoned", "cancelled"],
      final: [["root_cause_found", 1]],
      stages: [
        {
          name: "open",
          dwell: [15 * MINUTE, 0.7],
          advance: 0.98,
          exits: [["abandoned", 1]],
        },
        {
          name: "analyzing",
          dwell: [4 * HOUR, 1.0],
          tail: 0.08,
          advance: 0.9,
          exits: [
            ["inconclusive", 0.5],
            ["abandoned", 0.5],
          ],
        },
        {
          name: "remediation",
          dwell: [30 * MINUTE, 0.6],
          spawn: { kind: "remediation", count: [1, 2], within: 0.2 },
          onChildren: (kids) => (kids.includes("fixed") ? "next" : "inconclusive"),
        },
      ],
    },
    remediation: {
      parent: "investigation",
      relatedTo: "ticket",
      terminal: ["fixed", "failed", "reverted", "cancelled"],
      final: [
        ["fixed", 0.85],
        ["reverted", 0.15],
      ],
      stages: [
        {
          name: "planned",
          dwell: [30 * MINUTE, 0.8],
          advance: 0.95,
          exits: [["cancelled", 1]],
        },
        {
          name: "implementing",
          dwell: [2 * HOUR, 0.9],
          advance: 0.9,
          exits: [["failed", 1]],
        },
        { name: "verifying", dwell: [1 * HOUR, 0.7] },
      ],
    },
  },
};

export const PROCESSES = {
  recruiting,
  service_delivery: serviceDelivery,
  incident_response: incidentResponse,
};

// Derived lookup tables used by the validator.
for (const proc of Object.values(PROCESSES)) {
  for (const [kind, def] of Object.entries(proc.kinds)) {
    if (!def.terminal.includes("cancelled")) throw new Error(`${kind} must allow cancelled`);
    def.kind = kind;
    def.stageNames = new Set(def.stages.map((s) => s.name));
    if (def.side) def.stageNames.add(def.side.name);
    def.terminalSet = new Set(def.terminal);
  }
}

export const PROCESS_NAMES = Object.keys(PROCESSES);
