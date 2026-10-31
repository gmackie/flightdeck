import { accessHeaders } from "./auth";
import { CliError, type Deps } from "./deps";

/** `--url` wins over FLIGHTDECK_URL; HTTPS is required except for local wrangler dev. */
export function baseUrl(flag: string | undefined, deps: Deps): string {
  const raw = (flag ?? deps.env.FLIGHTDECK_URL ?? "").trim();
  if (!raw) throw new CliError("Pass --url <flightdeck url> or set FLIGHTDECK_URL.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`Not a URL: ${raw}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new CliError("The Flightdeck URL must use https:// (http:// only for localhost).");
  }
  return url.origin;
}

/** A JSON client for the Access-protected `/api/*` routes. */
export async function apiClient(url: string, deps: Deps) {
  const auth = await accessHeaders(url, deps);
  return async function request<T>(method: string, path: string, body?: unknown) {
    let res: Response;
    try {
      res = await deps.fetch(`${url}${path}`, {
        method,
        // Access answers unauthenticated requests with a login redirect; never follow it.
        redirect: "manual",
        headers: {
          ...auth,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new CliError(`Could not reach ${url}: ${(error as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new CliError(
        `Cloudflare Access rejected the credentials for ${url} (redirect to login).`,
      );
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) {
      const reason = data?.error ?? res.statusText;
      throw new CliError(`${method} ${path} failed: ${res.status} ${reason}`);
    }
    return { status: res.status, data: data as T };
  };
}

export type Request = Awaited<ReturnType<typeof apiClient>>;
