import { Redis } from '@upstash/redis';
import './env'; // makes sure .env is loaded before we read process.env below

/**
 * Upstash Redis (HTTP/REST based, so it works on serverless platforms like Vercel).
 *
 * The Upstash dashboard gives you UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
 * The Vercel "Upstash Redis" integration sets KV_REST_API_URL / KV_REST_API_TOKEN instead,
 * so both spellings are accepted.
 *
 * Redis is an optimisation, never a dependency: with no credentials configured (or if
 * Redis is down) every helper below quietly falls back to the database.
 */
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export const redis: Redis | null =
  url && token
    ? new Redis({
        url,
        token,
        retry: { retries: 1, backoff: () => 50 },
        // A slow cache must never make the app slower than having no cache.
        signal: () => AbortSignal.timeout(1500),
      })
    : null;

export const isCacheEnabled = redis !== null;

const PREFIX = 'aatmabal:';

/** Every cached value in the app. Add new keys here so invalidation stays in one place. */
export const CACHE_KEYS = {
  /** Which attendance date is currently open (read on every sevak request). */
  activeControl: 'active-control',
  /** The admin attendance sheet (a heavy multi-join query). */
  sheet: 'sheet',
} as const;

export type CacheKey = (typeof CACHE_KEYS)[keyof typeof CACHE_KEYS];

// Values are wrapped so that "null" (e.g. no date is active) is a cacheable answer
// and can be told apart from "not in the cache".
type Envelope<T> = { v: T };

/**
 * Cache-aside: return the cached value if present, otherwise run `load`,
 * store its result for `ttlSeconds`, and return it.
 */
export async function cached<T>(key: CacheKey, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  if (!redis) return load();

  const fullKey = PREFIX + key;

  try {
    const hit = await redis.get<Envelope<T>>(fullKey);
    if (hit) return hit.v;
  } catch (err) {
    console.error(`[cache] read of "${key}" failed, using the database`, err);
  }

  const value = await load();

  try {
    await redis.set(fullKey, { v: value } satisfies Envelope<T>, { ex: ttlSeconds });
  } catch (err) {
    console.error(`[cache] write of "${key}" failed`, err);
  }

  return value;
}

/** Drops cached values after the underlying data changed. Never throws. */
export async function invalidateCache(...keys: CacheKey[]): Promise<void> {
  if (!redis || !keys.length) return;

  try {
    await redis.del(...keys.map((key) => PREFIX + key));
  } catch (err) {
    // The short TTL on every key is the safety net if this ever fails.
    console.error('[cache] invalidation failed; entries will expire on their own', err);
  }
}
