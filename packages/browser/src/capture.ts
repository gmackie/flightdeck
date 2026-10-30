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

export function installCapture(doc: Document, emit: Emit): () => void {
  // Forms are covered by submit, and view elements only emit views.
  const onClick = (ev: Event) => {
    const el = (ev.target as Element | null)?.closest?.<HTMLElement>(`[${ATTR}]`);
    if (el && el.tagName !== "FORM" && !el.hasAttribute(VIEW_ATTR)) emitFor(emit, "click", el);
  };
  const onSubmit = (ev: Event) => {
    if (ev.target instanceof HTMLElement) emitFor(emit, "submit", ev.target);
  };
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("submit", onSubmit, true);

  const seen = new WeakSet<Element>();
  const io =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting || seen.has(entry.target)) continue;
              seen.add(entry.target);
              io?.unobserve(entry.target);
              emitFor(emit, "view", entry.target as HTMLElement);
            }
          },
          { threshold: 0.5 },
        );
  const observeAll = () => {
    for (const el of doc.querySelectorAll(`[${VIEW_ATTR}]`)) if (!seen.has(el)) io?.observe(el);
  };
  observeAll();
  const mo = new MutationObserver(observeAll);
  mo.observe(doc.documentElement, { childList: true, subtree: true });

  return () => {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("submit", onSubmit, true);
    io?.disconnect();
    mo.disconnect();
  };
}
