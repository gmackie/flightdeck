/** Rate limiter checks go through this object so tests can stub them with `vi.spyOn`. */
export const limits = {
  /**
   * Whether `appId` may make another lifecycle write now. Counts requests (batches, RPC calls,
   * registrations) per app over the binding's period. Without the opt-in binding, unlimited.
   */
  lifecycle: async (env: Env, appId: string): Promise<boolean> => {
    const limiter = (env as { LIFECYCLE_RATE_LIMIT?: RateLimit }).LIFECYCLE_RATE_LIMIT;
    if (!limiter) return true;
    const { success } = await limiter.limit({ key: appId });
    return success;
  },
};

/** Seconds a throttled producer should wait: the shortest period the binding supports. */
export const THROTTLE_RETRY_AFTER = 10;
