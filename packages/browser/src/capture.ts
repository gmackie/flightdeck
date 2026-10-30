import type { EventKind } from "@flightdeckhq/schema";

export const ATTR = "data-flightdeck";
const VIEW_ATTR = `${ATTR}-view`;

export type Emit = (kind: EventKind, name: string, props?: Record<string, string>) => void;

/** `data-flightdeck-plan="pro"` becomes `{ plan: "pro" }`. */
export function propsFrom(el: HTMLElement): Record<string, string> | undefined {
  const props: Record<string, string> = {};
  for (const [key, value] of Object.entries(el.dataset)) {
    if (!key.startsWith("flightdeck") || key === "flightdeck" || key === "flightdeckView") continue;
    if (value === undefined) continue;
    const name = key.slice("flightdeck".length);
    props[name.charAt(0).toLowerCase() + name.slice(1)] = value;
  }
  return Object.keys(props).length ? props : undefined;
}

/** Emits `kind` for `el` when it has a non-empty data-flightdeck name. */
function emitFor(emit: Emit, kind: EventKind, el: HTMLElement): void {
  const name = el.getAttribute(ATTR);
  if (name) emit(kind, name, propsFrom(el));
}

/** Half the element is visible, or it fills half the viewport (elements taller than 2x it). */
function seenEnough(entry: IntersectionObserverEntry): boolean {
  return (
    entry.isIntersecting &&
    (entry.intersectionRatio >= 0.5 ||
      entry.intersectionRect.height >= 0.5 * (entry.rootBounds?.height ?? innerHeight))
  );
}

export function installCapture(doc: Document, emit: Emit): () => void {
  // Forms are covered by submit, and view elements only emit views. composedPath() reaches
  // into open shadow roots, where `target` is retargeted to the host.
  const onClick = (ev: Event) => {
    const el = (ev.composedPath?.().find((n) => (n as Element).hasAttribute?.(ATTR)) ??
      (ev.target as Element | null)?.closest?.(`[${ATTR}]`)) as HTMLElement | null | undefined;
    if (el && el.tagName !== "FORM" && !el.hasAttribute(VIEW_ATTR)) emitFor(emit, "click", el);
  };
  const onSubmit = (ev: Event) => {
    if (ev.target instanceof HTMLElement) emitFor(emit, "submit", ev.target);
  };
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("submit", onSubmit, true);

  let stopViews = () => {};
  if (typeof IntersectionObserver !== "undefined") {
    const seen = new WeakSet<Element>();
    const selector = `[${VIEW_ATTR}]`;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!seenEnough(entry) || seen.has(entry.target)) continue;
          seen.add(entry.target);
          io.unobserve(entry.target);
          emitFor(emit, "view", entry.target as HTMLElement);
        }
      },
      { threshold: [0, 0.5] },
    );
    const observeIn = (root: ParentNode) => {
      for (const el of root.querySelectorAll(selector)) if (!seen.has(el)) io.observe(el);
    };
    observeIn(doc);
    // Only scan what was added, not the whole document, on every mutation.
    const mo = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(selector) && !seen.has(node)) io.observe(node);
          observeIn(node);
        }
    });
    mo.observe(doc.documentElement, { childList: true, subtree: true });
    stopViews = () => {
      io.disconnect();
      mo.disconnect();
    };
  }

  return () => {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("submit", onSubmit, true);
    stopViews();
  };
}
