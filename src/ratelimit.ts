import type { Store } from "./store";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  store: Store,
  bucket: string,
  limit: number,
  windowSeconds: number,
  nowSeconds: number,
): Promise<RateLimitResult> {
  const windowStart = nowSeconds - (nowSeconds % windowSeconds);
  const hits = await store.recordHit(bucket, windowStart, windowStart + windowSeconds);
  return {
    allowed: hits <= limit,
    retryAfterSeconds: windowStart + windowSeconds - nowSeconds,
  };
}
