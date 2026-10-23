/** API requests one client address may make per minute on casty serve; the page needs a few. */
export const API_LIMIT = 120;
export const API_LIMIT_NOTE = `${API_LIMIT} API requests a minute`;

/**
 * A fixed window per client address. ponytail: the windows are swept only when there are more
 * than 10000 of them, and at most once a window, so memory stays bounded without a timer and a
 * flood of addresses costs one scan a minute, not one a request.
 */
export function rateLimiter(limit: number, windowMs: number, now = Date.now) {
  const windows = new Map<string, { until: number; count: number }>();
  let swept = 0;
  return {
    /** Whether `client` may make one more request now; otherwise how many seconds to wait. */
    take(client: string): { allowed: true } | { allowed: false; retryAfter: number } {
      const at = now();
      let window = windows.get(client);
      if (!window || window.until <= at) {
        if (windows.size > 10_000 && at - swept >= windowMs) {
          for (const [key, w] of windows) if (w.until <= at) windows.delete(key);
          swept = at;
        }
        window = { until: at + windowMs, count: 0 };
        windows.set(client, window);
      }
      if (window.count >= limit) {
        return { allowed: false, retryAfter: Math.ceil((window.until - at) / 1000) };
      }
      window.count++;
      return { allowed: true };
    },
  };
}
