import type { LifecycleNode, LifecycleStage, LifecycleState, WorkflowSnapshot } from "./model";

/** Entirely invented examples. No source-system identifiers, people, or live provider state. */
export const DEMO_AS_OF = Date.UTC(2026, 9, 31, 12);
const HOUR = 3_600_000;
const ago = (hours: number) => DEMO_AS_OF - hours * HOUR;
const terminal = new Set<LifecycleState>(["completed", "rejected", "cancelled", "withdrawn"]);

function stages(
  labels: readonly string[],
  current: number,
  state: LifecycleState,
  owner: string,
  hours = 6,
  reason?: string,
): LifecycleStage[] {
  return labels.map((label, index) => {
    const stageState = index < current ? "completed" : index === current ? state : "future";
    return {
      id: `stage-${index}`,
      label,
      state: stageState,
      owner,
      ...(stageState !== "future"
        ? {
            enteredAt: ago((current - index + 1) * hours),
            ...(stageState === "completed" || terminal.has(stageState)
              ? { exitedAt: ago((current - index) * hours) }
              : {}),
          }
        : {}),
      ...(index === current && reason ? { reason } : {}),
    };
  });
}

const demandStages = ["Raised", "Review", "Approved", "Fulfilled"];
const reqStages = ["Draft", "Approved", "Open", "Filled", "Closed"];
const appStages = ["Received", "Screen", "Interview", "Offer", "Closed"];
export const LOOP_STAGES = [
  "Defined",
  "Interviewers assigned",
  "Scheduled",
  "Conducted",
  "Feedback",
  "Debrief",
  "Decision",
];
export const ASSESSMENT_STAGES = ["Assigned", "Scheduled", "Conducted", "Scorecard", "Finalized"];

function record(
  id: string,
  label: string,
  kind: string,
  state: LifecycleState,
  labels: readonly string[],
  current: number,
  owner: string,
  hours = 6,
  reason?: string,
  children?: readonly LifecycleNode[],
  relationship?: string,
): LifecycleNode {
  return {
    id,
    label,
    kind,
    state,
    owner,
    createdAt: ago((current + 2) * hours),
    ...(terminal.has(state) ? { endedAt: DEMO_AS_OF } : {}),
    stages: stages(labels, current, state, owner, hours, reason),
    children,
    relationship,
  };
}

const assessments: LifecycleNode[] = [
  record(
    "assessment-systems",
    "Systems exercise",
    "Assessment",
    "active",
    ASSESSMENT_STAGES,
    3,
    "Panel A",
    2,
    "Scorecard being written",
    undefined,
    "Parallel · panel A",
  ),
  record(
    "assessment-collaboration",
    "Collaboration exercise",
    "Assessment",
    "waiting",
    ASSESSMENT_STAGES,
    1,
    "Panel B",
    2,
    "Waiting for panel availability",
    undefined,
    "Parallel · panel B",
  ),
  record(
    "assessment-craft",
    "Craft exercise",
    "Assessment",
    "completed",
    ASSESSMENT_STAGES,
    4,
    "Panel C",
    1,
    "Scorecard finalized",
    undefined,
    "Parallel · panel C",
  ),
];

const applications: LifecycleNode[] = [
  record(
    "application-001",
    "Application 001",
    "Application",
    "active",
    appStages,
    2,
    "Review team",
    24,
    "Interview evaluation in progress",
    [
      record(
        "loop-001",
        "Interview loop 001",
        "Interview loop",
        "active",
        LOOP_STAGES,
        3,
        "Loop coordinator",
        4,
        "Assessments run in parallel; one panel is still scheduling",
        assessments,
      ),
    ],
  ),
  record(
    "application-002",
    "Application 002",
    "Application",
    "rejected",
    appStages,
    1,
    "Review team",
    18,
    "Synthetic example: role requirements not met",
  ),
  record(
    "application-003",
    "Application 003",
    "Application",
    "withdrawn",
    appStages,
    2,
    "Review team",
    12,
    "Synthetic example: applicant opted out",
  ),
  record(
    "application-004",
    "Application 004",
    "Application",
    "paused",
    appStages,
    1,
    "Review team",
    36,
    "Availability on hold until next cycle",
  ),
];

const jobExamples: [string, LifecycleState, number, string][] = [
  ["REQ-103 · Data platform", "waiting", 1, "Approval pending"],
  ["REQ-104 · Reliability", "paused", 2, "Budget checkpoint"],
  ["REQ-105 · Developer experience", "deferred", 0, "Moved to next planning cycle"],
  ["REQ-106 · Research", "cancelled", 2, "Initiative cancelled"],
  ["REQ-107 · Customer support", "completed", 4, "Role filled and requisition closed"],
  ["REQ-108 · Security", "active", 2, "Applications under review"],
  ["REQ-109 · Documentation", "withdrawn", 0, "Request withdrawn by owning team"],
  ["REQ-110 · Analytics", "rejected", 1, "Request declined during approval"],
  ["REQ-111 · Infrastructure", "active", 2, "Interviews in progress"],
  ["REQ-112 · Quality engineering", "waiting", 1, "Awaiting planning review"],
];

const headcount: LifecycleNode[] = [
  record(
    "demand-platform",
    "Platform capacity",
    "Headcount demand",
    "active",
    demandStages,
    2,
    "Planning team",
    96,
    "Approved demand remains open until fulfilled",
    [
      record(
        "req-101",
        "REQ-101 · Platform engineer",
        "Requisition",
        "active",
        reqStages,
        2,
        "Platform team",
        48,
        "Open role; child application outcomes do not close this requisition",
        applications,
      ),
    ],
  ),
  record(
    "demand-pending",
    "Growth capacity · pending",
    "Headcount demand",
    "waiting",
    demandStages,
    1,
    "Planning team",
    48,
    "Pending budget approval",
    [
      record(
        "req-102",
        "REQ-102 · Product design",
        "Requisition",
        "active",
        reqStages,
        0,
        "Design team",
        16,
        "Draft prepared while headcount approval is pending",
      ),
    ],
  ),
  record(
    "demand-deferred",
    "Next-cycle expansion",
    "Headcount demand",
    "deferred",
    demandStages,
    1,
    "Planning team",
    72,
    "Deferred to next quarter",
  ),
  record(
    "demand-rejected",
    "Regional expansion",
    "Headcount demand",
    "rejected",
    demandStages,
    1,
    "Planning team",
    24,
    "Demand rejected: no funded initiative",
  ),
  record(
    "demand-shared",
    "Shared services capacity",
    "Headcount demand",
    "active",
    demandStages,
    2,
    "Planning team",
    48,
    "Multiple independent requisitions",
    jobExamples.map(([label, state, current, reason], index) =>
      record(
        `req-${103 + index}`,
        label,
        "Requisition",
        state,
        reqStages,
        current,
        "Service team",
        8 + index * 3,
        reason,
      ),
    ),
  ),
];

const deploymentStages = ["Proposed", "Build", "Validate", "Rollout", "Verify", "Complete"];
const incidentStages = ["Detected", "Triaged", "Mitigating", "Monitoring", "Resolved", "Review"];

export const DEMO_SNAPSHOT: WorkflowSnapshot = {
  asOf: DEMO_AS_OF,
  source: { label: "Synthetic local fixtures · no live system data", synthetic: true },
  portfolios: [
    {
      id: "headcount",
      label: "Headcount & hiring",
      description: "Demand → requisition → application → interview loop → parallel assessments",
      roots: headcount,
    },
    {
      id: "deployments",
      label: "Service deploys",
      description:
        "Invented services and rollout outcomes; no actual provider or environment state",
      roots: [
        record(
          "deploy-01",
          "Example API · release 42",
          "Service deploy",
          "active",
          deploymentStages,
          3,
          "Delivery team",
          0.5,
          "Canary verification in progress",
          [
            record(
              "deploy-test",
              "Integration validation",
              "Validation",
              "completed",
              ["Queued", "Running", "Passed"],
              2,
              "Test runner",
              0.25,
            ),
            record(
              "deploy-region-a",
              "Example region A",
              "Rollout",
              "completed",
              ["Queued", "Deploying", "Healthy"],
              2,
              "Delivery team",
              0.25,
              undefined,
              undefined,
              "Parallel region",
            ),
            record(
              "deploy-region-b",
              "Example region B",
              "Rollout",
              "paused",
              ["Queued", "Deploying", "Healthy"],
              1,
              "Delivery team",
              0.5,
              "Manual checkpoint before continuing",
              undefined,
              "Parallel region",
            ),
          ],
        ),
        record(
          "deploy-02",
          "Example web · release 18",
          "Service deploy",
          "completed",
          deploymentStages,
          5,
          "Delivery team",
          0.25,
        ),
        record(
          "deploy-03",
          "Example queue · release 7",
          "Service deploy",
          "cancelled",
          deploymentStages,
          2,
          "Delivery team",
          0.5,
          "Superseded by release 8",
        ),
        record(
          "deploy-04",
          "Example cache · release 3",
          "Service deploy",
          "rejected",
          deploymentStages,
          2,
          "Delivery team",
          0.25,
          "Validation gate failed",
        ),
      ],
    },
    {
      id: "incidents",
      label: "Incidents",
      description: "Synthetic incident response with independent mitigation work",
      roots: [
        record(
          "incident-01",
          "Example latency regression",
          "Incident",
          "active",
          incidentStages,
          3,
          "Response team",
          0.75,
          "Monitoring recovery before resolution",
          [
            record(
              "mitigation-01",
              "Restore capacity",
              "Mitigation",
              "completed",
              ["Proposed", "Applied", "Verified"],
              2,
              "Response team",
              0.25,
            ),
            record(
              "mitigation-02",
              "Investigate slow queries",
              "Investigation",
              "active",
              ["Assigned", "Investigating", "Findings"],
              1,
              "Database team",
              0.5,
            ),
          ],
        ),
        record(
          "incident-02",
          "Example webhook delay",
          "Incident",
          "completed",
          incidentStages,
          5,
          "Response team",
          0.5,
        ),
        record(
          "incident-03",
          "Example duplicate alert",
          "Incident",
          "withdrawn",
          incidentStages,
          1,
          "Response team",
          0.25,
          "Duplicate report withdrawn",
        ),
      ],
    },
  ],
};
