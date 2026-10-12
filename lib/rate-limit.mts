/**
 * Sliding-window rate limit, in memory.
 *
 * Per process: it resets on redeploy and does not coordinate between serverless instances, so
 * the real ceiling is roughly `limit x instances`. That is fine for keeping a free-tier LLM key
 * from being drained by one visitor, and wrong for anything that needs a hard guarantee.
 */

const hits = new Map<string, number[]>();

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

export function checkRateLimit(
  key: string,
  limit = 20,
  windowMs = 60 * 60 * 1000,
  now = Date.now(),
): RateLimitResult {
  const cutoff = now - windowMs;
  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

  if (recent.length >= limit) {
    hits.set(key, recent);
    const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  recent.push(now);
  hits.set(key, recent);

  // Opportunistic sweep so idle keys don't accumulate forever.
  if (hits.size > 5000) {
    for (const [k, times] of hits) if (times.every((t) => t <= cutoff)) hits.delete(k);
  }

  return { allowed: true, remaining: limit - recent.length, retryAfterSeconds: 0 };
}

/** Test seam. */
export function resetRateLimits() {
  hits.clear();
}

/** Best-effort client address behind Vercel's proxy. */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}
