import { Tooltip, TooltipProvider } from "@cloudflare/kumo/components/tooltip";
import { useId, useRef, useState } from "react";
import {
  duration,
  type LifecycleStage,
  type LifecycleState,
  STATE_LABELS,
  STATE_MARKS,
  stageAge,
  stageDwell,
  stageTimeProblem,
} from "./model";

export function StateBadge({ state }: { state: LifecycleState }) {
  return (
    <span className="wf-state" data-state={state}>
      <span aria-hidden="true">{STATE_MARKS[state]}</span> {STATE_LABELS[state]}
    </span>
  );
}

export function StageTooltip({
  stage,
  asOf,
  id,
}: {
  stage: LifecycleStage;
  asOf: number;
  id: string;
}) {
  return (
    <div className="wf-tooltip" role="tooltip" id={id}>
      <strong>{stage.label}</strong>
      <dl>
        <div>
          <dt>State</dt>
          <dd>{STATE_LABELS[stage.state]}</dd>
        </div>
        <div>
          <dt>Dwell</dt>
          <dd>
            {duration(stageDwell(stage, asOf))}
            {stageDwell(stage, asOf) !== undefined && stage.exitedAt === undefined
              ? " · ongoing"
              : ""}
          </dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{stage.owner}</dd>
        </div>
        <div>
          <dt>Age since entry</dt>
          <dd>{duration(stageAge(stage, asOf))}</dd>
        </div>
        <div>
          <dt>Reason</dt>
          <dd>
            {stage.reason ?? (stage.state === "future" ? "Not entered yet" : "No reason recorded")}
          </dd>
        </div>
        {stageTimeProblem(stage, asOf) ? (
          <div>
            <dt>Timing</dt>
            <dd>{stageTimeProblem(stage, asOf)}; duration unavailable</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function StageSegment({
  stage,
  asOf,
  tabIndex,
  onFocus,
  buttonRef,
}: {
  stage: LifecycleStage;
  asOf: number;
  tabIndex: number;
  onFocus: () => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  return (
    <Tooltip
      open={open}
      onOpenChange={(next, details) => {
        // Click/tap opens details; Kumo's default trigger-press dismissal would undo it.
        if (details.reason !== "trigger-press") setOpen(next);
      }}
      delay={150}
      closeDelay={100}
      side="bottom"
      content={<StageTooltip stage={stage} asOf={asOf} id={tooltipId} />}
      render={
        <button
          ref={buttonRef}
          type="button"
          className="wf-segment"
          data-state={stage.state}
          tabIndex={tabIndex}
          aria-describedby={open ? tooltipId : undefined}
          onFocus={onFocus}
          onClick={() => setOpen(true)}
          aria-label={`${stage.label}: ${STATE_LABELS[stage.state]}, dwell ${duration(stageDwell(stage, asOf))}`}
        />
      }
    >
      <span className="wf-segment-label">
        <span aria-hidden="true">{STATE_MARKS[stage.state]}</span> {stage.label}
      </span>
      <span className="wf-segment-dwell" aria-hidden="true">
        {duration(stageDwell(stage, asOf))}
      </span>
    </Tooltip>
  );
}

/** Equal-width stages show sequence, not elapsed-time proportions. */
export function LifecycleBar({
  label,
  stages,
  asOf,
}: {
  label: string;
  stages: readonly LifecycleStage[];
  asOf: number;
}) {
  const [focused, setFocused] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <TooltipProvider>
      <div
        role="toolbar"
        aria-label={`${label} lifecycle stages`}
        aria-orientation="horizontal"
        className="wf-bar"
        onKeyDown={(event) => {
          const index = buttons.current.indexOf(document.activeElement as HTMLButtonElement);
          if (index < 0) return;
          const next =
            event.key === "ArrowRight"
              ? (index + 1) % stages.length
              : event.key === "ArrowLeft"
                ? (index - 1 + stages.length) % stages.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? stages.length - 1
                    : undefined;
          if (next === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          buttons.current[next]?.focus();
        }}
      >
        {stages.map((stage, index) => (
          <StageSegment
            key={stage.id}
            stage={stage}
            asOf={asOf}
            tabIndex={Math.min(focused, stages.length - 1) === index ? 0 : -1}
            onFocus={() => setFocused(index)}
            buttonRef={(element) => {
              buttons.current[index] = element;
            }}
          />
        ))}
        {!stages.length ? <span className="wf-muted">No stages defined</span> : null}
      </div>
    </TooltipProvider>
  );
}
