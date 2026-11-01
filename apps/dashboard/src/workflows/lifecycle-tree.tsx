import { type KeyboardEvent, useId, useRef, useState } from "react";
import { LifecycleBar, StateBadge } from "./lifecycle-bar";
import { duration, flattenNodes, type LifecycleNode } from "./model";

export function LifecycleRow({
  node,
  asOf,
  expanded,
  onToggle,
}: {
  node: LifecycleNode;
  asOf: number;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="wf-row">
      <div className="wf-identity">
        {onToggle ? (
          <button
            type="button"
            className="wf-disclosure"
            onClick={onToggle}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.label}`}
            aria-expanded={expanded}
          >
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
        ) : (
          <span className="wf-leaf" aria-hidden="true">
            ·
          </span>
        )}
        <div className="wf-name">
          <strong>{node.label}</strong>
          <span>
            {node.kind} · {node.relationship ?? node.owner}
            {node.outcome ? ` · outcome ${node.outcome}` : ""}
          </span>
        </div>
      </div>
      <LifecycleBar label={node.label} stages={node.stages} asOf={asOf} />
      <StateBadge state={node.state} />
      <span className="wf-age">
        <span className="wf-sr">Age </span>
        {duration((node.endedAt ?? asOf) - node.createdAt)}
      </span>
    </div>
  );
}

export function LifecycleTree({
  nodes,
  asOf,
  label,
  initialExpanded = [],
}: {
  nodes: readonly LifecycleNode[];
  asOf: number;
  label: string;
  initialExpanded?: readonly string[];
}) {
  const [expanded, setExpanded] = useState(() => new Set(initialExpanded));
  const [focused, setFocused] = useState(nodes[0]?.id);
  const tree = useRef<HTMLUListElement>(null);
  const helpId = useId();
  const visible: { node: LifecycleNode; parent?: string }[] = [];
  const collect = (items: readonly LifecycleNode[], parent?: string) => {
    for (const node of items) {
      visible.push({ node, parent });
      if (expanded.has(node.id)) collect(node.children ?? [], node.id);
    }
  };
  collect(nodes);
  const effectiveFocus = visible.some(({ node }) => node.id === focused) ? focused : nodes[0]?.id;

  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const focus = (id: string | undefined) => {
    if (!id) return;
    setFocused(id);
    const item = Array.from(
      tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    ).find((element) => element.dataset.nodeId === id);
    item?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLLIElement>, node: LifecycleNode) => {
    // Stage toolbars and disclosure buttons retain their native keyboard behavior.
    if (event.target !== event.currentTarget) return;
    const index = visible.findIndex((entry) => entry.node.id === node.id);
    const hasChildren = Boolean(node.children?.length);
    switch (event.key) {
      case "ArrowDown":
        focus(visible[index + 1]?.node.id);
        break;
      case "ArrowUp":
        focus(visible[index - 1]?.node.id);
        break;
      case "Home":
        focus(visible[0]?.node.id);
        break;
      case "End":
        focus(visible.at(-1)?.node.id);
        break;
      case "ArrowRight":
        if (hasChildren && !expanded.has(node.id)) toggle(node.id);
        else if (hasChildren) focus(node.children?.[0]?.id);
        break;
      case "ArrowLeft":
        if (hasChildren && expanded.has(node.id)) toggle(node.id);
        else focus(visible[index]?.parent);
        break;
      case "Enter":
      case " ":
        if (hasChildren) toggle(node.id);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  const renderNodes = (items: readonly LifecycleNode[], level: number) =>
    items.map((node) => {
      const hasChildren = Boolean(node.children?.length);
      const isExpanded = hasChildren && expanded.has(node.id);
      return (
        <li
          role="treeitem"
          key={node.id}
          data-node-id={node.id}
          aria-label={`${node.label}, ${node.kind}`}
          aria-level={level}
          aria-expanded={hasChildren ? isExpanded : undefined}
          tabIndex={effectiveFocus === node.id ? 0 : -1}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setFocused(node.id);
          }}
          onKeyDown={(event) => onKey(event, node)}
        >
          <LifecycleRow
            node={node}
            asOf={asOf}
            expanded={isExpanded}
            onToggle={
              hasChildren
                ? () => {
                    focus(node.id);
                    toggle(node.id);
                  }
                : undefined
            }
          />
          {isExpanded ? (
            // biome-ignore lint/a11y/useSemanticElements: ARIA trees require nested groups, not form fieldsets.
            <ul role="group">{renderNodes(node.children ?? [], level + 1)}</ul>
          ) : null}
        </li>
      );
    });
  return (
    <>
      <div className="wf-tree-tools">
        <p id={helpId}>
          ↑↓ move rows · ←→ expand/collapse · Tab to stages, then ←→ · Escape closes details
        </p>
        <button
          type="button"
          onClick={() =>
            setExpanded(
              new Set(
                flattenNodes(nodes)
                  .filter((node) => node.children?.length)
                  .map((node) => node.id),
              ),
            )
          }
        >
          Expand all
        </button>
        <button type="button" onClick={() => setExpanded(new Set())}>
          Collapse all
        </button>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll overflowing rows. */}
      <section className="wf-scroll" aria-label={`${label} lifecycle rows`} tabIndex={0}>
        <div className="wf-columns" aria-hidden="true">
          <span>Workflow / owner</span>
          <span>Lifecycle · equal-width stages</span>
          <span>State</span>
          <span>Age</span>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ul/tree is the standard ARIA tree pattern, with roving focus and arrow keys. */}
        <ul ref={tree} className="wf-tree" role="tree" aria-label={label} aria-describedby={helpId}>
          {renderNodes(nodes, 1)}
        </ul>
      </section>
      {!nodes.length ? (
        <p className="wf-empty" role="status">
          No workflows match this search.
        </p>
      ) : null}
    </>
  );
}
