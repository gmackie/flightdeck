import type { AppScope, Capability, Grant, LifecycleReadSource, Principal, Role } from "./source";

/** Mirrors FLIG-18: aggregates (`process:read`) need analyst or higher. */
const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  reader: ["lifecycle:read"],
  analyst: ["lifecycle:read", "process:read"],
  owner: ["lifecycle:read", "process:read"],
  admin: ["lifecycle:read", "process:read"],
};

const ROLES = Object.keys(ROLE_CAPABILITIES) as Role[];

/** Service tokens never act above reader, whatever their grant says (FLIG-18's service ceiling). */
const SERVICE_CEILING: Role = "reader";

export type Denial = { code: "forbidden" | "source_unavailable" };

/**
 * Resolves the caller's grants once per request. A failure to load them denies every app-scoped
 * call; it never falls back to "allow".
 */
export class Authorizer {
  #grants: Promise<Grant[] | null> | null = null;

  constructor(
    private readonly principal: Principal,
    private readonly source: LifecycleReadSource,
    private readonly now: () => number,
  ) {}

  private grants(): Promise<Grant[] | null> {
    this.#grants ??= this.source.grantsFor(this.principal).then(
      (grants) => (Array.isArray(grants) ? grants : null),
      () => null,
    );
    return this.#grants;
  }

  /** Unknown apps and apps without a grant get the same denial, so ids cannot be probed. */
  async authorize(appId: string, capability: Capability): Promise<AppScope | Denial> {
    const grants = await this.grants();
    if (!grants) return { code: "source_unavailable" };
    const now = this.now();
    const allowed = grants.some(
      (grant) =>
        grant.appId === appId &&
        (grant.expiresAt === null || grant.expiresAt > now) &&
        effectiveCapabilities(grant.role, this.principal).includes(capability),
    );
    if (!allowed) return { code: "forbidden" };
    return { appId, capability, principal: this.principal } as AppScope;
  }

  /** App ids the caller may use `capability` on, for resource listings. */
  async appsWith(capability: Capability): Promise<string[]> {
    const grants = (await this.grants()) ?? [];
    const now = this.now();
    const apps = grants
      .filter((grant) => grant.expiresAt === null || grant.expiresAt > now)
      .filter((grant) => effectiveCapabilities(grant.role, this.principal).includes(capability))
      .map((grant) => grant.appId);
    return [...new Set(apps)].sort();
  }
}

function effectiveCapabilities(role: Role, principal: Principal): readonly Capability[] {
  if (!ROLES.includes(role)) return [];
  const capped =
    principal.serviceToken && ROLES.indexOf(role) > ROLES.indexOf(SERVICE_CEILING)
      ? SERVICE_CEILING
      : role;
  return ROLE_CAPABILITIES[capped];
}
