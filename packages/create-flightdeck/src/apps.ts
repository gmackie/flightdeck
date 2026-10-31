import { createHash } from "node:crypto";
import type { Request } from "./client";
import { CliError, type Deps } from "./deps";

type App = { id: string; name: string; created_at: number };
type Binding = { binding: string; service: string; entrypoint: string; props: { appId: string } };

export const SKILL_URL =
  "https://github.com/gmackie/flightdeck/tree/main/skills/flightdeck-instrument-worker";
const DAY = 24 * 60 * 60 * 1000;
export const MAX_KEY_DAYS = 400;

export async function listApps(request: Request, deps: Deps, json: boolean): Promise<void> {
  const { data } = await request<{ apps: App[] }>("GET", "/api/apps");
  if (json) return deps.stdout(`${JSON.stringify(data, null, 2)}\n`);
  if (!data.apps.length) return deps.stdout("No apps registered.\n");
  const width = Math.max(...data.apps.map((a) => a.id.length));
  for (const app of data.apps) deps.stdout(`${app.id.padEnd(width)}  ${app.name}\n`);
}

export async function addApp(
  request: Request,
  deps: Deps,
  opts: { name: string; stage?: string; json: boolean },
): Promise<void> {
  const { status, data } = await request<{ app: App; binding: Binding }>("POST", "/api/apps", {
    name: opts.name,
    ...(opts.stage ? { stage: opts.stage } : {}),
  });
  const created = status === 201;
  if (opts.json) return deps.stdout(`${JSON.stringify({ created, ...data }, null, 2)}\n`);
  const where = opts.stage && opts.stage !== "production" ? ` (env.${opts.stage})` : "";
  const block = JSON.stringify({ services: [data.binding] }, null, 2);
  deps.stdout(
    [
      `${created ? "Registered" : "Already registered"} ${data.app.name} as ${data.app.id}.`,
      "",
      `Add this service binding to wrangler.jsonc${where}:`,
      "",
      block,
      "",
      "Next steps:",
      "  1. Wrap your fetch handler with withFlightdeck(...) from @flightdeckhq/worker.",
      `  2. Follow the flightdeck-instrument-worker skill: ${SKILL_URL}`,
      "",
    ].join("\n"),
  );
}

/**
 * Mints a server ingest key locally. Only its SHA-256 digest is sent; the raw key is
 * printed once (or written to a 0600 file) after the server accepted the digest.
 */
export async function addKey(
  request: Request,
  deps: Deps,
  opts: { appId: string; days: number; out?: string; json: boolean },
): Promise<void> {
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > MAX_KEY_DAYS) {
    throw new CliError(`--days must be a whole number from 1 to ${MAX_KEY_DAYS}.`);
  }
  const key = Buffer.from(deps.randomBytes(32)).toString("base64url");
  const token_hash = createHash("sha256").update(key).digest("hex");
  const expires_at = deps.now() + opts.days * DAY;
  await request("POST", `/api/apps/${encodeURIComponent(opts.appId)}/server-keys`, {
    token_hash,
    expires_at,
  });
  const expires = new Date(expires_at).toISOString();
  if (opts.out) {
    await deps.writeSecretFile(opts.out, `${key}\n`);
  }
  if (opts.json) {
    const out = opts.out ? { file: opts.out } : { key };
    deps.stdout(
      `${JSON.stringify({ app_id: opts.appId, token_hash, expires_at, ...out }, null, 2)}\n`,
    );
  } else if (!opts.out) {
    deps.stdout(`${key}\n`);
  }
  const notes = [
    `Key for ${opts.appId}, digest ${token_hash}, expires ${expires}.`,
    "Store it as a secret now (e.g. wrangler secret put); it is not shown again and cannot be recovered.",
    `Revoke it with: create-flightdeck apps revoke-key ${opts.appId} ${token_hash}`,
  ];
  if (opts.out) notes.unshift(`Wrote the server ingest key to ${opts.out} (mode 0600).`);
  deps.stderr(`${notes.join("\n")}\n`);
}

export async function revokeKey(
  request: Request,
  deps: Deps,
  opts: { appId: string; hash: string },
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(opts.hash)) throw new CliError("Expected a SHA-256 hex digest.");
  await request("DELETE", `/api/apps/${encodeURIComponent(opts.appId)}/server-keys/${opts.hash}`);
  deps.stderr(`Revoked ${opts.hash} for ${opts.appId}.\n`);
}
