const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;

interface Bucket {
  count: number;
  resetAt: number;
}

let buckets = new Map<string, Bucket>();

export function checkRateLimit(
  key: string,
  now: number = Date.now(),
): { allowed: boolean; retryAfterMs: number } {
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > MAX_REQUESTS) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  return { allowed: true, retryAfterMs: 0 };
}

export function _resetRateLimitForTests(): void {
  buckets = new Map();
}
