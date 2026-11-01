/**
 * Production stays off in this build. Flip it only in a reviewed change once the Workstream H read
 * API is integrated, app grants come from the FLIG-18 policy, and the rollout checklist in
 * docs/operations/lifecycle-mcp.md has been verified on staging.
 */
export const PRODUCTION_ENABLED = false;

/** Groups smaller than this are always withheld; configuration can only raise it. */
export const MIN_COHORT_FLOOR = 5;
const MIN_COHORT_CEILING = 1000;

export type SourceMode = "disabled" | "synthetic" | "read-api";
export type Environment = "development" | "staging" | "production";

export type Config = {
  environment: Environment;
  source: Exclude<SourceMode, "disabled">;
  /** null only for the local development bypass. */
  access: { teamDomain: string; audience: string } | null;
  minCohort: number;
  allowedOrigins: Set<string>;
};

export type Refusal = { status: number; error: string };

export type ConfigEnv = {
  LIFECYCLE_MCP_ENVIRONMENT?: string;
  LIFECYCLE_MCP_SOURCE?: string;
  LIFECYCLE_MCP_MIN_COHORT?: string;
  LIFECYCLE_MCP_DEV?: string;
  LIFECYCLE_MCP_ALLOWED_ORIGINS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
};

const ENVIRONMENTS: readonly Environment[] = ["development", "staging", "production"];
const SOURCES: readonly SourceMode[] = ["disabled", "synthetic", "read-api"];

/** Reads the Worker configuration, failing closed: anything unset or unknown refuses to serve. */
export function readConfig(env: ConfigEnv): Config | Refusal {
  const rawEnvironment = env.LIFECYCLE_MCP_ENVIRONMENT?.trim() ?? "";
  // An unset or unknown environment is treated as production.
  const environment = (ENVIRONMENTS as readonly string[]).includes(rawEnvironment)
    ? (rawEnvironment as Environment)
    : "production";
  if (environment === "production" && !PRODUCTION_ENABLED) {
    return { status: 503, error: "Lifecycle MCP is not enabled for production" };
  }
  const source = env.LIFECYCLE_MCP_SOURCE?.trim() ?? "";
  if (!(SOURCES as readonly string[]).includes(source)) {
    return { status: 503, error: "Lifecycle MCP is misconfigured" };
  }
  if (source === "disabled") return { status: 503, error: "Lifecycle MCP is disabled" };

  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const audience = env.ACCESS_AUD?.trim() ?? "";
  let access: Config["access"] = null;
  if (teamDomain && audience) {
    access = { teamDomain, audience };
  } else if (
    // Local `wrangler dev` only: never with real data and never outside development.
    !(env.LIFECYCLE_MCP_DEV === "1" && environment === "development" && source === "synthetic")
  ) {
    return { status: 503, error: "Access not configured" };
  }

  const allowedOrigins = new Set(
    (env.LIFECYCLE_MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  return {
    environment,
    source: source as Config["source"],
    access,
    minCohort: parseMinCohort(env.LIFECYCLE_MCP_MIN_COHORT),
    allowedOrigins,
  };
}

function parseMinCohort(raw: string | undefined): number {
  const value = Number(raw?.trim());
  if (!Number.isInteger(value)) return MIN_COHORT_FLOOR;
  return Math.min(Math.max(value, MIN_COHORT_FLOOR), MIN_COHORT_CEILING);
}
