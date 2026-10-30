/** The AppDO holding live counters for one app and one UTC hour. */
export const appShard = (env: Env, appId: string, hour: string) =>
  env.APP.get(env.APP.idFromName(`${appId}:${hour}`));

/** The SessionDO assembling one visitor session's journey. */
export const sessionStub = (env: Env, appId: string, sessionId: string) =>
  env.SESSION.get(env.SESSION.idFromName(`${appId}:${sessionId}`));
