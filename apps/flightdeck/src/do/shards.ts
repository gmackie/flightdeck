/**
 * The AppDO holding live counters for one app, one UTC hour, and one shard.
 * Only shard 0 is used today; the index is in the key so hot hours can split later.
 */
export const appShard = (env: Env, appId: string, hour: string, shard = 0) =>
  env.APP.get(env.APP.idFromName(`${appId}:${hour}:${shard}`));

/** The SessionDO assembling one visitor session's journey. */
export const sessionStub = (env: Env, appId: string, sessionId: string) =>
  env.SESSION.get(env.SESSION.idFromName(`${appId}:${sessionId}`));
