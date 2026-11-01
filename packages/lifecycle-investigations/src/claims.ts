import type { EvidencePack } from "./types.js";

export interface AgentClaim {
  claim: string;
  kind: "observation" | "association" | "hypothesis" | "cannot_determine";
  findingIds: readonly string[];
  evidenceRefs: readonly string[];
  uncertainty: { level: "low" | "medium" | "high"; notes: string };
  counterevidence: readonly string[];
  actionProposal: {
    kind: "none" | "next-measurement" | "data-quality-fix" | "process-experiment";
    description: string;
  };
}

export interface AgentAnalysis {
  evidencePackId: string;
  claims: readonly AgentClaim[];
  missingEvidence: readonly string[];
  nextMeasurements: readonly string[];
}

export type ClaimIssue =
  | "wrong-pack"
  | "malformed"
  | "no-evidence"
  | "unknown-finding"
  | "unknown-ref"
  | "ref-not-in-finding"
  | "undetermined-finding-as-fact"
  | "pack-cannot-determine"
  | "causal-language"
  | "unsupported-experiment"
  | "unstated-uncertainty"
  | "unsupported-statement"
  | "incomplete-refs";

const CAUSAL =
  /\b(caused|causes|causing|because of|due to|led to|leads to|resulted in|results in|drove|drives|driven by)\b/i;

/**
 * Deterministic check of a client model's structured output against the evidence pack it
 * cites. It cannot verify prose semantics; it verifies grounding, refs and claim discipline.
 */
export function validateAgentAnalysis(
  pack: EvidencePack,
  analysis: AgentAnalysis,
): { valid: boolean; issues: { claim: number | null; issue: ClaimIssue }[] } {
  const issues: { claim: number | null; issue: ClaimIssue }[] = [];
  if (!analysis || typeof analysis !== "object" || !Array.isArray(analysis.claims))
    return { valid: false, issues: [{ claim: null, issue: "malformed" }] };
  if (analysis.evidencePackId !== pack.id) issues.push({ claim: null, issue: "wrong-pack" });
  if (
    !Array.isArray(analysis.missingEvidence) ||
    !Array.isArray(analysis.nextMeasurements) ||
    ![...analysis.missingEvidence, ...analysis.nextMeasurements].every(
      (item) => typeof item === "string",
    ) ||
    analysis.claims.length > 20 ||
    Object.keys(analysis).some(
      (key) => !["evidencePackId", "claims", "missingEvidence", "nextMeasurements"].includes(key),
    )
  )
    return { valid: false, issues: [{ claim: null, issue: "malformed" }] };
  const findings = new Map(pack.findings.map((finding) => [finding.id, finding]));
  const rows = new Set(pack.evidence.flatMap((entry) => entry.rows.map((row) => row.ref)));
  for (const [index, claim] of analysis.claims.entries()) {
    const add = (issue: ClaimIssue) => issues.push({ claim: index, issue });
    if (
      !claim ||
      Object.keys(claim).some(
        (key) =>
          ![
            "claim",
            "kind",
            "findingIds",
            "evidenceRefs",
            "uncertainty",
            "counterevidence",
            "actionProposal",
          ].includes(key),
      ) ||
      typeof claim.claim !== "string" ||
      !Array.isArray(claim.findingIds) ||
      !Array.isArray(claim.evidenceRefs)
    ) {
      add("malformed");
      continue;
    }
    const findingIds: readonly string[] = claim.findingIds,
      evidenceRefs: readonly string[] = claim.evidenceRefs;
    if (CAUSAL.test(JSON.stringify(claim))) add("causal-language");
    if (
      !["observation", "association", "hypothesis", "cannot_determine"].includes(claim.kind) ||
      !claim.uncertainty ||
      !["low", "medium", "high"].includes(claim.uncertainty.level) ||
      !claim.actionProposal ||
      !["none", "next-measurement", "data-quality-fix", "process-experiment"].includes(
        claim.actionProposal.kind,
      ) ||
      typeof claim.actionProposal.description !== "string" ||
      !Array.isArray(claim.counterevidence) ||
      !claim.counterevidence.every((item: unknown) => typeof item === "string") ||
      !findingIds.every((item) => typeof item === "string") ||
      !evidenceRefs.every((item) => typeof item === "string")
    ) {
      add("malformed");
      continue;
    }
    if (
      claim.kind === "cannot_determine" &&
      !findingIds.length &&
      !evidenceRefs.length &&
      claim.claim === "Cannot determine from this evidence pack." &&
      claim.actionProposal.kind !== "process-experiment"
    )
      continue;
    if (claim.kind !== "cannot_determine" && pack.status === "cannot_determine")
      add("pack-cannot-determine");
    if (!findingIds.length || !evidenceRefs.length) add("no-evidence");
    const cited = findingIds.map((id) => findings.get(id));
    if (cited.some((finding) => !finding)) add("unknown-finding");
    if (evidenceRefs.some((ref) => !rows.has(ref))) add("unknown-ref");
    // Exact templated text prevents invented statistics or causal paraphrases from
    // borrowing a valid citation. Free-form recommendations are advisory, not evidence.
    if (cited.length !== 1 || claim.claim !== cited[0]?.statement) add("unsupported-statement");
    if (
      claim.kind === "cannot_determine" &&
      cited.some((finding) => finding?.status !== "cannot_determine")
    )
      add("undetermined-finding-as-fact");
    const allowed = new Set(cited.flatMap((finding) => finding?.evidenceRefs ?? []));
    if ([...allowed].some((ref) => !evidenceRefs.includes(ref))) add("incomplete-refs");
    if (evidenceRefs.some((ref) => rows.has(ref) && !allowed.has(ref))) add("ref-not-in-finding");
    if (
      claim.kind !== "cannot_determine" &&
      cited.some((finding) => finding?.status === "cannot_determine")
    )
      add("undetermined-finding-as-fact");
    if (
      claim.actionProposal?.kind === "process-experiment" &&
      !cited.some((finding) => finding?.status === "observed")
    )
      add("unsupported-experiment");
    if (
      !claim.uncertainty ||
      typeof claim.uncertainty.notes !== "string" ||
      !claim.uncertainty.notes.trim()
    )
      add("unstated-uncertainty");
  }
  return { valid: issues.length === 0, issues };
}
