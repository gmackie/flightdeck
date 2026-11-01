import { createHash } from "node:crypto";
import type { Request } from "./client";
import { CliError, type Deps, type SecretFile } from "./deps";

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
  opts: { appId: string; days: number; out?: string; json: boolean; scopes?: string[] },
): Promise<void> {
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > MAX_KEY_DAYS) {
    throw new CliError(`--days must be a whole number from 1 to ${MAX_KEY_DAYS}.`);
  }
  const scopes = opts.scopes?.length ? checkScopes(opts.scopes) : undefined;
  // Claim the output file first: a key the server accepted but nobody holds is a live credential.
  let file: SecretFile | undefined;
  if (opts.out) {
    try {
      file = await deps.openSecretFile(opts.out);
    } catch (error) {
      throw new CliError(`Cannot create ${opts.out}: ${message(error)}. No key was created.`);
    }
  }
  const key = Buffer.from(deps.randomBytes(32)).toString("base64url");
  const token_hash = createHash("sha256").update(key).digest("hex");
  const expires_at = deps.now() + opts.days * DAY;
  const revoke = `npx @flightdeckhq/create apps revoke-key ${opts.appId} ${token_hash}`;
  try {
    await request("POST", `/api/apps/${encodeURIComponent(opts.appId)}/server-keys`, {
      token_hash,
      expires_at,
      ...(scopes ? { scopes } : {}),
    });
  } catch (error) {
    await file?.discard();
    throw error;
  }
  const expires = new Date(expires_at).toISOString();
  if (file) {
    try {
      await file.write(`${key}\n`);
      await file.close();
    } catch (error) {
      await file.discard();
      throw new CliError(
        [
          `Registered a key for ${opts.appId} (digest ${token_hash}) but could not write ${opts.out}: ${message(error)}`,
          `Nobody holds this key. Revoke it with: ${revoke}`,
        ].join("\n"),
      );
    }
  }
  if (opts.json) {
    const out = opts.out ? { file: opts.out } : { key };
    const extra = { ...(scopes ? { scopes } : {}), ...out };
    deps.stdout(
      `${JSON.stringify({ app_id: opts.appId, token_hash, expires_at, ...extra }, null, 2)}\n`,
    );
  } else if (!opts.out) {
    deps.stdout(`${key}\n`);
  }
  const notes = [
    `Key for ${opts.appId}, digest ${token_hash}, expires ${expires}${scopes ? `, scopes ${scopes.join(" ")}` : ""}.`,
    "Store it as a secret now (e.g. wrangler secret put); it is not shown again and cannot be recovered.",
    `Revoke it with: ${revoke}`,
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

export const SCOPES = ["events.write", "lifecycle.write"];

function checkScopes(scopes: string[]): string[] {
  const bad = scopes.find((s) => !SCOPES.includes(s));
  if (bad) throw new CliError(`Unknown scope ${bad}; expected ${SCOPES.join(" or ")}.`);
  return [...new Set(scopes)];
}

/** Grants or revokes an app's lifecycle.write (needs a principal in LIFECYCLE_ADMINS). */
export async function setLifecycle(
  request: Request,
  deps: Deps,
  opts: { appId: string; grant: boolean },
): Promise<void> {
  const path = `/api/apps/${encodeURIComponent(opts.appId)}/capabilities/lifecycle.write`;
  const { status } = await request(opts.grant ? "PUT" : "DELETE", path);
  const what = opts.grant ? (status === 201 ? "Granted" : "Already granted") : "Revoked";
  deps.stderr(`${what} lifecycle.write for ${opts.appId}.\n`);
}

/** Replaces a key's scopes by digest (needs a principal in LIFECYCLE_ADMINS). */
export async function setKeyScopes(
  request: Request,
  deps: Deps,
  opts: { appId: string; hash: string; scopes: string[] },
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(opts.hash)) throw new CliError("Expected a SHA-256 hex digest.");
  if (!opts.scopes.length) throw new CliError("Pass at least one --scope.");
  const scopes = checkScopes(opts.scopes);
  const app = encodeURIComponent(opts.appId);
  await request("PUT", `/api/apps/${app}/server-keys/${opts.hash}/scopes`, { scopes });
  deps.stderr(`Set scopes of ${opts.hash} for ${opts.appId}: ${scopes.join(" ")}.\n`);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
