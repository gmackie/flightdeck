export type AppRecord = { id: string; name: string; access_aud: string | null };

const HIT_TTL_MS = 60_000;
const MISS_TTL_MS = 5_000;
const cache = new Map<string, { app: AppRecord | null; expires: number }>();

export async function getApp(
  db: D1Database,
  id: string,
  now = Date.now(),
): Promise<AppRecord | null> {
  const hit = cache.get(id);
  if (hit && hit.expires > now) return hit.app;
  const app = await db
    .prepare("SELECT id, name, access_aud FROM apps WHERE id = ?")
    .bind(id)
    .first<AppRecord>();
  cache.set(id, { app, expires: now + (app ? HIT_TTL_MS : MISS_TTL_MS) });
  return app;
}

export function clearAppCache(): void {
  cache.clear();
}
