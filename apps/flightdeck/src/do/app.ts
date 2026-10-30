import { DurableObject } from "cloudflare:workers";

export class AppDO extends DurableObject<Env> {}
