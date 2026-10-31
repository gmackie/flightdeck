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
