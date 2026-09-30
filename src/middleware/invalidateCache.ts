import type { RequestHandler } from 'express';
import { invalidateCache, type CacheKey } from '../cache';

/**
 * For routers whose non-GET requests change cached data.
 *
 * After a write succeeds, the given cache keys are dropped *before* the response is sent,
 * so the client's very next read (e.g. the list refresh after "Save") is never stale.
 * Failed writes (status >= 400) leave the cache alone.
 */
export function invalidateCacheOnWrite(...keys: CacheKey[]): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }

    const send = res.json.bind(res);

    res.json = ((body?: unknown) => {
      if (res.statusCode >= 400) return send(body);

      // invalidateCache never rejects, so the response is always sent.
      void invalidateCache(...keys).then(() => send(body));
      return res;
    }) as typeof res.json;

    next();
  };
}
