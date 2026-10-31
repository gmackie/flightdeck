import type { IngestRpc } from "@flightdeckhq/schema";
import { handleFlightdeck } from "@flightdeckhq/worker";

/** Flightdeck's own app id; migration 0003 registers it. */
export const DOGFOOD_APP_ID = "app_flightdeck";

type Props = Record<string, string | number | boolean | null>;

/**
 * The Worker's own Ingest entrypoint as a loopback binding, so the dashboard's events take the
 * same RPC path as any app's `FLIGHTDECK` service binding.
 */
function ingest(ctx: ExecutionContext): IngestRpc {
  return ctx.exports.Ingest({ props: { appId: DOGFOOD_APP_ID } });
}

/** Serves the dashboard's `/_fd/e` browser endpoint; any other `/_fd/*` path is a 404. */
export async function dogfood(request: Request, ctx: ExecutionContext): Promise<Response> {
  const res = await handleFlightdeck(request, { FLIGHTDECK: ingest(ctx) });
  return res ?? new Response("Not found", { status: 404 });
}

/** Records a server-side app_flightdeck event after the response; failures are only logged. */
export function trackDogfood(ctx: ExecutionContext, name: string, props?: Props): void {
  ctx.waitUntil(
    ingest(ctx)
      .track({ name, ...(props ? { props } : {}) })
      .then(
        () => {},
        (error: unknown) => console.error("Flightdeck dogfood event failed", error),
      ),
  );
}
