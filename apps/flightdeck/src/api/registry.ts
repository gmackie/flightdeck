import * as v from "valibot";

/** Production apps get the bare id; every other stage is suffixed so stages never share data. */
export const PRODUCTION = "production";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID = 64;

export const NewApp = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)),
  stage: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(32), v.regex(SLUG))),
});

/** `ForgeGraph Web` -> `forgegraph-web`: lowercase ASCII words joined by single hyphens. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The stable app id: `app_<slug>` for production (as `app_demo`, `app_bob`), else
 * `app_<slug>_<stage>`. Slugs only contain `-`, so `_` unambiguously separates the parts.
 * Returns null when the name has no usable characters or the id would exceed 64 chars.
 */
export function appIdentity(
  name: string,
  stage: string = PRODUCTION,
): { id: string; name: string } | null {
  const slug = slugify(name);
  if (!slug) return null;
  const production = stage === PRODUCTION;
  const id = production ? `app_${slug}` : `app_${slug}_${stage}`;
  if (id.length > MAX_ID) return null;
  return { id, name: production ? name : `${name} (${stage})` };
}

/** The wrangler `services` entry an app Worker pastes to get `env.FLIGHTDECK`. */
export function serviceBinding(service: string, appId: string) {
  return { binding: "FLIGHTDECK", service, entrypoint: "Ingest", props: { appId } };
}

export const TOKEN_HASH = /^[0-9a-f]{64}$/;
export const MAX_KEY_LIFETIME_MS = 400 * 24 * 60 * 60 * 1000;

export const NewServerKey = v.object({
  token_hash: v.pipe(v.string(), v.regex(TOKEN_HASH)),
  expires_at: v.pipe(v.number(), v.integer()),
});
