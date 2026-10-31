import { Select } from "@cloudflare/kumo/components/select";
import { track } from "@flightdeckhq/browser";
import type { App } from "./api";
import type { AppsState } from "./use-apps";

/**
 * Header control for the selected app. The wrapper's `data-flightdeck` names clicks that open
 * it; the choice itself is tracked explicitly, since keyboard selection fires no click.
 */
export function AppSwitcher(props: {
  state: AppsState;
  selected: App | null;
  onSelect: (appId: string) => void;
}) {
  const { state, selected } = props;
  const apps = state.status === "ok" ? state.apps : [];
  const placeholder =
    state.status === "signed-out"
      ? "Signed out"
      : state.status === "forbidden"
        ? "No access"
        : state.status === "error"
          ? "Apps unavailable"
          : state.status === "ok" && apps.length === 0
            ? "No apps"
            : "Select an app";
  return (
    <div className="fd-app-switcher" data-flightdeck="app.switch">
      <Select
        aria-label="Select app"
        size="sm"
        className="fd-app-select"
        placeholder={placeholder}
        loading={state.status === "loading"}
        disabled={apps.length === 0}
        value={selected?.id ?? null}
        items={apps.map((app) => ({ label: app.name, value: app.id }))}
        onValueChange={(appId) => {
          if (typeof appId !== "string" || appId === selected?.id) return;
          track("app.switched", { app: appId });
          props.onSelect(appId);
        }}
      />
    </div>
  );
}
