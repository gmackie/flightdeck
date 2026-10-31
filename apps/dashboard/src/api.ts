/** A registered app, as returned by `GET /api/apps`. `created_at` is epoch milliseconds. */
export type App = { id: string; name: string; created_at: number };

export type AppsResult =
  | { status: "ok"; apps: App[] }
  /** No valid Cloudflare Access session: missing, expired, or redirected to the login page. */
  | { status: "signed-out" }
  /** Signed in, but not allowed to use this Flightdeck. */
  | { status: "forbidden" }
  | { status: "error"; message: string };

function isApp(value: unknown): value is App {
  if (typeof value !== "object" || value === null) return false;
  const { id, name, created_at } = value as Record<string, unknown>;
  return typeof id === "string" && typeof name === "string" && typeof created_at === "number";
}

/** A dashboard API read. `not-found` is a 404, e.g. an app that is no longer registered. */
export type Loaded<T> =
  | { status: "ok"; data: T }
  | { status: "signed-out" }
  | { status: "forbidden" }
  | { status: "not-found" }
  | { status: "error"; message: string };

/** GETs a same-origin `/api/*` JSON resource and checks its shape. Never throws. */
export async function getJson<T>(
  url: string,
  valid: (body: unknown) => body is T,
  what: string,
  fetcher: typeof fetch = fetch,
): Promise<Loaded<T>> {
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      // An expired Access session answers with a 302 to the team's login domain. Following it
      // cross-origin fails CORS (a TypeError), so stop at the redirect and read it as signed out.
      redirect: "manual",
    });
  } catch {
    return { status: "error", message: "Flightdeck is unreachable." };
  }
  if (res.type === "opaqueredirect" || res.status === 0 || res.status === 401) {
    return { status: "signed-out" };
  }
  if (res.status === 403) return { status: "forbidden" };
  if (res.status === 404) return { status: "not-found" };
  if (!res.ok) return { status: "error", message: `Loading ${what} failed (HTTP ${res.status}).` };
  const body: unknown = await res.json().catch(() => null);
  if (!valid(body))
    return { status: "error", message: "Flightdeck returned an unexpected response." };
  return { status: "ok", data: body };
}

const isAppList = (body: unknown): body is { apps: App[] } => {
  const apps = (body as { apps?: unknown } | null)?.apps;
  return Array.isArray(apps) && apps.every(isApp);
};

/** Lists the apps the signed-in user can see. Never throws. */
export async function fetchApps(fetcher: typeof fetch = fetch): Promise<AppsResult> {
  const result = await getJson("/api/apps", isAppList, "apps", fetcher);
  if (result.status === "ok") return { status: "ok", apps: result.data.apps };
  if (result.status === "not-found")
    return { status: "error", message: "Loading apps failed (HTTP 404)." };
  return result;
}
