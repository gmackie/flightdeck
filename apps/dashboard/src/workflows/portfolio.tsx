import { LifecycleRow } from "./lifecycle-tree";
import {
  duration,
  LIFECYCLE_STATES,
  type LifecycleNode,
  STATE_LABELS,
  summarizePortfolio,
} from "./model";

export function PortfolioSummary({
  nodes,
  asOf,
}: {
  nodes: readonly LifecycleNode[];
  asOf: number;
}) {
  const summary = summarizePortfolio(nodes, asOf);
  return (
    <section className="wf-summary" aria-label="Portfolio summary">
      <dl className="wf-summary-metrics">
        <div>
          <dt>Workflows</dt>
          <dd>{summary.total}</dd>
        </div>
        <div>
          <dt>p50 completed dwell</dt>
          <dd>{duration(summary.completedDwell.p50)}</dd>
        </div>
        <div>
          <dt>p90 completed dwell</dt>
          <dd>{duration(summary.completedDwell.p90)}</dd>
        </div>
        <div>
          <dt>p50 open-stage age</dt>
          <dd>{duration(summary.openStageAge.p50)}</dd>
        </div>
        <div>
          <dt>p90 open-stage age</dt>
          <dd>{duration(summary.openStageAge.p90)}</dd>
        </div>
      </dl>
      <section className="wf-outcomes" aria-label="Workflow state and outcome counts">
        {LIFECYCLE_STATES.filter((state) => state !== "future").map((state) => (
          <span key={state} className="wf-state" data-state={state}>
            {STATE_LABELS[state]} <strong>{summary.counts[state]}</strong>
          </span>
        ))}
      </section>
      <p className="wf-summary-note">
        All {summary.total} workflows, including nested children · {summary.completedDwell.count}{" "}
        completed-stage samples · {summary.openStageAge.count} open stages (right-censored ages) ·{" "}
        {summary.invalidStages} invalid timing samples excluded. Open ages are not completion times.
      </p>
    </section>
  );
}

/** Generic flat portfolio; callers choose the record kind to include. */
export function LifecyclePortfolio({
  nodes,
  asOf,
  label,
}: {
  nodes: readonly LifecycleNode[];
  asOf: number;
  label: string;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll overflowing rows.
    <section className="wf-scroll" aria-label={label} tabIndex={0}>
      <ul className="wf-portfolio" aria-label={label}>
        {nodes.map((node) => {
          const summary = summarizePortfolio([node], asOf);
          return (
            <li key={node.id}>
              <LifecycleRow node={node} asOf={asOf} />
              <div className="wf-job-metrics">
                <span>
                  Completed dwell p50 {duration(summary.completedDwell.p50)} / p90{" "}
                  {duration(summary.completedDwell.p90)} (n={summary.completedDwell.count})
                </span>
                <span>
                  Open-stage age p50 {duration(summary.openStageAge.p50)} / p90{" "}
                  {duration(summary.openStageAge.p90)} (n={summary.openStageAge.count})
                </span>
                <span>{summary.total - 1} nested workflows</span>
                <span>
                  {summary.counts.completed} completed · {summary.counts.rejected} rejected ·{" "}
                  {summary.counts.cancelled} cancelled · {summary.counts.withdrawn} withdrawn
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {!nodes.length ? (
        <p className="wf-empty" role="status">
          No workflows match this search.
        </p>
      ) : null}
    </section>
  );
}
