import { init } from "@flightdeckhq/browser";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./app";
import { followSystemTheme } from "./theme";

/**
 * Starts the dashboard. Flightdeck instruments itself as app_flightdeck: the browser SDK posts
 * to the Worker's own same-origin `/_fd/e`, like any other app.
 */
export function boot(container: HTMLElement): Root {
  init({ endpoint: "/_fd/e" });
  followSystemTheme();
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  return root;
}
