/** A registered app, as returned by `GET /api/apps`. `created_at` is epoch milliseconds. */
export type App = { id: string; name: string; created_at: number };

export type AppsResult =
  | { status: "ok"; apps: App[] }
  /** Cloudflare Access rejected the request: the session is missing or expired. */
  | { status: "signed-out" }
  | { status: "error"; message: string };

function isApp(value: unknown): value is App {
  if (typeof value !== "object" || value === null) return false;
  const { id, name, created_at } = value as Record<string, unknown>;
  return typeof id === "string" && typeof name === "string" && typeof created_at === "number";
}

/** Lists the apps the signed-in user can see. Never throws. */
export async function fetchApps(fetcher: typeof fetch = fetch): Promise<AppsResult> {
  let res: Response;
  try {
    res = await fetcher("/api/apps", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
  } catch {
    return { status: "error", message: "Flightdeck is unreachable." };
  }
  if (res.status === 401 || res.status === 403) return { status: "signed-out" };
  if (!res.ok) return { status: "error", message: `Loading apps failed (HTTP ${res.status}).` };
  const body: unknown = await res.json().catch(() => null);
  const apps = (body as { apps?: unknown } | null)?.apps;
  if (!Array.isArray(apps) || !apps.every(isApp)) {
    return { status: "error", message: "Flightdeck returned an unexpected response." };
  }
  return { status: "ok", apps };
}
