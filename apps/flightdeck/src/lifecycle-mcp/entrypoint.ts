import { WorkerEntrypoint } from "cloudflare:workers";
import {
  LifecycleReadRequest,
  type LifecycleReadResult,
  type LifecycleReadRpc,
} from "@flightdeckhq/schema";
import type { JWTVerifyGetKey } from "jose";
import * as v from "valibot";
import { verifyAccessPrincipal } from "../access";
import { authorizeLifecycleRead } from "../api/authorization";
import { audit, isAggregateRead, reserveAggregate } from "../lifecycle-privacy/guard";
import { BadQuery } from "../lifecycle-serving/params";
import { executeRead, readGrants } from "./read";

/** No fetch() implementation and no public route. Bind this named entrypoint explicitly. */
export class LifecycleReadEntrypoint extends WorkerEntrypoint<Env> implements LifecycleReadRpc {
  read(assertion: string, appId: string | null, request: unknown): Promise<LifecycleReadResult> {
    return privateLifecycleRead(this.env, assertion, appId, request);
  }
}

/** Only the unit/integration harness supplies local JWKS; RPC callers cannot supply keys/principals. */
export async function privateLifecycleRead(
  env: Env,
  assertion: unknown,
  appId: unknown,
  input: unknown,
  keys?: JWTVerifyGetKey,
): Promise<LifecycleReadResult> {
  if (
    env.LIFECYCLE_MCP_READ_ENABLED !== "1" ||
    !env.LIFECYCLE_MCP_ACCESS_AUD?.trim() ||
    !env.ACCESS_TEAM_DOMAIN.trim() ||
    !env.ACCESS_AUD.trim() ||
    env.LIFECYCLE_MCP_ACCESS_AUD.trim() === env.ACCESS_AUD.trim()
  ) {
    return { ok: false, code: "source_unavailable" };
  }
  if (typeof assertion !== "string" || !assertion || assertion.length > 16_384) {
    return { ok: false, code: "unauthorized" };
  }
  const principal = await verifyAccessPrincipal(assertion, {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    audience: env.LIFECYCLE_MCP_ACCESS_AUD.trim(),
    keys,
  });
  if (!principal || principal.sub.length > 256) return { ok: false, code: "unauthorized" };
  const request = v.safeParse(LifecycleReadRequest, input);
  if (!request.success) return { ok: false, code: "invalid_argument" };
  try {
    const q = request.output;
    if (q.method === "grantsFor") {
      if (appId !== null) return { ok: false, code: "invalid_argument" };
      return { ok: true, appId: null, value: await readGrants(env.DB, principal) };
    }
    // App id and capability are untrusted request selectors, never proof of access.
    if (typeof appId !== "string") return { ok: false, code: "forbidden" };
    const aggregate = isAggregateRead(q);
    const scope = await authorizeLifecycleRead(
      env,
      principal,
      appId,
      aggregate ? "process:read" : "lifecycle:read",
    );
    if (scope instanceof Response)
      return { ok: false, code: scope.status === 403 ? "forbidden" : "source_unavailable" };
    const reservation = isAggregateRead(q)
      ? await reserveAggregate(env, principal, scope.appId, q)
      : undefined;
    const recheck = () =>
      authorizeLifecycleRead(
        env,
        principal,
        scope.appId,
        aggregate ? "process:read" : "lifecycle:read",
      );
    // Recheck after accounting and immediately before reading; a revoked scope is not a grant.
    if ((await recheck()) instanceof Response) {
      if (reservation) await audit(env.DB, reservation, "withheld");
      return { ok: false, code: "forbidden" };
    }
    let value: Awaited<ReturnType<typeof executeRead>>;
    try {
      value = await executeRead(env.DB, scope.appId, q, reservation, async () => {
        if ((await recheck()) instanceof Response) throw new Error("Read unavailable");
      });
      // Do not release data if access was revoked while executing the read.
      if ((await recheck()) instanceof Response) {
        if (reservation) await audit(env.DB, reservation, "withheld");
        return { ok: false, code: "forbidden" };
      }
    } catch (error) {
      if (reservation) await audit(env.DB, reservation, "withheld");
      throw error;
    }
    // No oversized or arbitrary response bodies cross the private boundary.
    if (JSON.stringify(value).length > 60_000) {
      if (reservation) await audit(env.DB, reservation, "withheld");
      return { ok: false, code: "source_unavailable" };
    }
    if (reservation) await audit(env.DB, reservation, "released");
    return { ok: true, appId: scope.appId, value };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof BadQuery ? "invalid_argument" : "source_unavailable",
    };
  }
}
