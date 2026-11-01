import type { Diagnostic } from "./types.js";

/** Presentation/logging boundary: omit raw subject IDs, event IDs and source-derived text.
 * Programmatic replay diagnostics retain opaque references for repair; never render them as HTML.
 */
export function sanitizeDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const known = new Set<Diagnostic["code"]>([
    "unsupported_event",
    "duplicate_conflict",
    "invalid_time",
    "invalid_sequence",
    "sequence_time_conflict",
    "ambiguous_order",
    "missing_reference",
    "invalid_definition",
    "invalid_transition",
    "missing_boundary",
    "cycle",
    "correction_conflict",
  ]);
  return diagnostics.map((d) => ({
    code: known.has(d.code) ? d.code : "unsupported_event",
    subject: "redacted",
    message: "Lifecycle evidence is incomplete or inconsistent; inspect the authorized source log.",
  }));
}
