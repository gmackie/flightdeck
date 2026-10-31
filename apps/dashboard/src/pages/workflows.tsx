import { Button } from "@cloudflare/kumo/components/button";
import { Surface } from "@cloudflare/kumo/components/surface";
import { useState } from "react";
import { demoWorkflowAdapter, type WorkflowDataAdapter } from "../workflows/adapter";
import { StateBadge } from "../workflows/lifecycle-bar";
import { LifecycleTree } from "../workflows/lifecycle-tree";
import { filterHierarchy, flattenNodes, LIFECYCLE_STATES } from "../workflows/model";
import { LifecyclePortfolio, PortfolioSummary } from "../workflows/portfolio";
import "../workflows/workflows.css";
import { PageHeader } from "./page-header";

const INITIAL_EXPANDED = [
  "demand-platform",
  "req-101",
  "application-001",
  "loop-001",
  "demand-shared",
  "deploy-01",
  "incident-01",
];

export function WorkflowsPage({
  adapter = demoWorkflowAdapter,
}: {
  adapter?: WorkflowDataAdapter;
}) {
  const snapshot = adapter.read();
  const [domain, setDomain] = useState(snapshot.portfolios[0]?.id ?? "");
  const [view, setView] = useState("hierarchy");
  const [query, setQuery] = useState("");
  const portfolio =
    snapshot.portfolios.find((item) => item.id === domain) ?? snapshot.portfolios[0];
  const allNodes = portfolio?.roots ?? [];
  const jobsView = domain === "headcount" && view === "jobs";
  const nodes = jobsView
    ? filterHierarchy(
        flattenNodes(allNodes).filter((node) => node.kind === "Requisition"),
        query,
      )
    : filterHierarchy(allNodes, query);
  return (
    <div className="wf-page">
      <PageHeader
        title="Workflows"
        subtitle="Every lifecycle, in one line. Expand the work behind it."
        actions={<span className="wf-demo-badge">DEMO · SYNTHETIC</span>}
      />
      <aside className="wf-demo-notice" aria-label="Demo data notice">
        <strong>Invented examples. No live system data.</strong>
        <span>
          {snapshot.source.label}. This demo does not show actual Cloudflare, hiring, deployment, or
          incident state.
        </span>
        <span>
          Frozen snapshot · {new Date(snapshot.asOf).toISOString().replace("T", " ").slice(0, 16)}{" "}
          UTC
        </span>
      </aside>
      <div className="wf-controls">
        <fieldset className="fd-segmented" aria-label="Workflow domain">
          {snapshot.portfolios.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={item.id === domain ? "primary" : "ghost"}
              aria-pressed={item.id === domain}
              onClick={() => {
                setDomain(item.id);
                setQuery("");
              }}
            >
              {item.label}
            </Button>
          ))}
        </fieldset>
        <label className="wf-search">
          Search workflows
          <input
            type="search"
            value={query}
            placeholder="Name, owner, state…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <Surface className="fd-card wf-card">
        <div className="wf-section-header">
          <div>
            <h2>{portfolio?.label ?? "Workflows"}</h2>
            <p>{portfolio?.description}</p>
          </div>
          {domain === "headcount" ? (
            <fieldset className="fd-segmented" aria-label="Portfolio layout">
              <Button
                size="sm"
                variant={view === "hierarchy" ? "primary" : "ghost"}
                aria-pressed={view === "hierarchy"}
                onClick={() => setView("hierarchy")}
              >
                Hierarchy
              </Button>
              <Button
                size="sm"
                variant={view === "jobs" ? "primary" : "ghost"}
                aria-pressed={view === "jobs"}
                onClick={() => setView("jobs")}
              >
                Many jobs
              </Button>
            </fieldset>
          ) : null}
        </div>
        <PortfolioSummary nodes={nodes} asOf={snapshot.asOf} />
        <section className="wf-legend" aria-label="Lifecycle state legend">
          {LIFECYCLE_STATES.map((state) => (
            <StateBadge key={state} state={state} />
          ))}
        </section>
        {jobsView ? (
          <LifecyclePortfolio nodes={nodes} asOf={snapshot.asOf} label="Many jobs" />
        ) : (
          <LifecycleTree
            key={`${domain}:${query}`}
            nodes={nodes}
            asOf={snapshot.asOf}
            label={portfolio?.label ?? "Workflows"}
            initialExpanded={query ? flattenNodes(nodes).map((node) => node.id) : INITIAL_EXPANDED}
          />
        )}
        <p className="wf-footnote">
          Each row shows its own lifecycle. Child outcomes do not determine the parent’s progress.
          Equal-width segments show stage order; labels show dwell. Ongoing dwell is measured up to
          the frozen snapshot.
        </p>
      </Surface>
    </div>
  );
}
