import { WorkerEntrypoint } from "cloudflare:workers";
import type { EventSource, IngestResult, IngestRpc, StoredEvent } from "@flightdeckhq/schema";
import { ulid } from "ulid";
import { verifyAccessUser } from "../access";
import { type AppRecord, getApp } from "../apps";
import { appShard, sessionStub } from "../do/shards";
import { sinks } from "../sinks";
import { type IngestDeps, IngestError, ingestBatch } from "./service";

export type IngestProps = { appId?: string };

/** Service binding target for app Workers: `env.FLIGHTDECK.ingest(...)`, `.track(...)`, `.identify(...)`. */
export class Ingest extends WorkerEntrypoint<Env, IngestProps> implements IngestRpc {
  ingest(batch: unknown): Promise<IngestResult> {
    return this.run(batch, "browser");
  }

  /** A server-side custom event. Non-object input becomes an invalid event and is rejected. */
  track(event: unknown): Promise<IngestResult> {
    return this.run({ events: [serverEvent(event, { kind: "track" })] }, "server");
  }

  /** Links a user id to the visitor; input without `userId` is rejected. */
  identify(input: unknown): Promise<IngestResult> {
    return this.run(
      { events: [serverEvent(input, { kind: "identify", name: "identify" })] },
      "server",
    );
  }

  private async run(input: unknown, source: EventSource): Promise<IngestResult> {
    const appId = this.ctx.props?.appId;
    if (!appId) throw new IngestError("service binding is missing props.appId");
    const app = await getApp(this.env.DB, appId);
    if (!app) throw new IngestError(`unknown app ${appId}`);
    return ingestBatch(appId, input, source, deps(this.env, app));
  }
}

/** Stamps `ts` and forces the kind; a non-object stays a non-object so validation rejects it. */
function serverEvent(value: unknown, fixed: { kind: string; name?: string }): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ts: Date.now(), ...value, ...fixed };
}

function deps(env: Env, app: AppRecord): IngestDeps {
  const teamDomain = env.ACCESS_TEAM_DOMAIN.trim();
  return {
    now: Date.now,
    newId: () => ulid(),
    // verifyAccessUser normalizes the team domain; an empty domain turns Access identity off.
    resolveUser: async (jwt) =>
      teamDomain ? verifyAccessUser(jwt, { teamDomain, audience: app.access_aud }) : null,
    sendEvents: (rows: StoredEvent[]) => sinks.events(env, rows),
    appendToSession: (appId, sessionId, rows) =>
      sessionStub(env, appId, sessionId).append(appId, sessionId, rows),
    recordCounts: (appId, hour, rows) => appShard(env, appId, hour).recordEvents(rows),
  };
}
