import type { diagnoseWorkflowSnapshot } from "./adapter";

/** Invalid stage timings from `diagnoseWorkflowSnapshot`, listed rather than clamped. */
export function TimingDiagnostics({
  diagnostics,
}: {
  diagnostics: ReturnType<typeof diagnoseWorkflowSnapshot>;
}) {
  if (!diagnostics.length) return null;
  return (
    <aside className="wf-demo-notice" aria-label="Workflow timing diagnostics">
      <strong>
        {diagnostics.length} invalid stage timing samples · durations unavailable and excluded from
        percentiles
      </strong>
      <details>
        <summary>Review timestamp problems</summary>
        <ul>
          {diagnostics.map((diagnostic) => (
            <li key={`${diagnostic.portfolioId}:${diagnostic.nodeId}:${diagnostic.stageId}`}>
              {diagnostic.nodeLabel} · {diagnostic.stageLabel}: {diagnostic.message}
            </li>
          ))}
        </ul>
      </details>
    </aside>
  );
}
