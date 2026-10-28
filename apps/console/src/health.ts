/** Called only after the Console has independently verified an Access JWT. */
export async function consoleHealth(env: {
  META?: D1Database;
  CORE?: { status(): Promise<unknown> };
  BASIN_SQL_TOKEN?: string;
  ACCOUNT_ID?: string;
  BASIN_BUCKET?: string;
}): Promise<Response> {
  let metadata = false, core = false;
  try {
    metadata = (await env.META?.prepare("SELECT 1 AS ok").first<{ok:number}>())?.ok === 1;
  } catch { /* Report only component status, never provider errors. */ }
  try {
    const result = await env.CORE?.status();
    core = !!result && typeof result === "object" && "ok" in result && result.ok === true;
  } catch { /* Private binding failures must make health fail. */ }
  const queryConfigured = !!(env.BASIN_SQL_TOKEN && env.ACCOUNT_ID && env.BASIN_BUCKET);
  const ok = metadata && core && queryConfigured;
  return Response.json({ok, metadata, core, queryConfigured, eventPathVerified:false}, {
    status:ok ? 200 : 503,
    headers:{"Cache-Control":"no-store"},
  });
}
