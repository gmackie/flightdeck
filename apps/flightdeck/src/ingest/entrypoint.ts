import { WorkerEntrypoint } from "cloudflare:workers";

export class Ingest extends WorkerEntrypoint<Env, { appId: string }> {}
