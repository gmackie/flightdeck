import { DurableObject } from "cloudflare:workers";

export class SessionDO extends DurableObject<Env> {}
