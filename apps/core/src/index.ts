import { WorkerEntrypoint } from "cloudflare:workers";
/** Private RPC boundary; no unpersisted durability acknowledgments. */
export default class AnalyticsCore extends WorkerEntrypoint { async captureBatch(_input: unknown): Promise<never> { throw new Error("Source authorization and durable Basin sink not configured"); } }
