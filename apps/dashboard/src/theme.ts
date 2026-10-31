import { useSyncExternalStore } from "react";

const DARK = "(prefers-color-scheme: dark)";

/** Kumo themes on `data-mode`; keep it in step with the system setting. Returns a cleanup. */
export function followSystemTheme(root: HTMLElement = document.documentElement): () => void {
  const query = matchMedia(DARK);
  const apply = () => {
    root.dataset.mode = query.matches ? "dark" : "light";
  };
  apply();
  query.addEventListener("change", apply);
  return () => query.removeEventListener("change", apply);
}

function subscribeMode(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
  return () => observer.disconnect();
}

/** True while Kumo is in dark mode; charts re-theme when it flips. */
export function useDarkMode(): boolean {
  return useSyncExternalStore(
    subscribeMode,
    () => document.documentElement.dataset.mode === "dark",
  );
}
