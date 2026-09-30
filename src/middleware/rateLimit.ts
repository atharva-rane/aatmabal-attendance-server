import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { Ratelimit } from '@upstash/ratelimit';
import { redis } from '../cache';

const TOO_MANY = { message: 'Too many requests. Please try again in a little while.' };

type Options = { name: string; max: number; windowSeconds: number };

/**
 * A rate limiter whose counters live in Redis, so the limit holds across every server
 * instance. This matters on Vercel, where each request may hit a different instance and
 * an in-memory counter would let an attacker try passwords far more often than intended.
 *
 * Without Redis (local dev) or if Redis fails mid-request, it uses an in-memory limiter,
 * so protection is never switched off.
 *
 * Costs one Redis command per request, so it is used only on the sensitive endpoints
 * (admin login, attendance submit), not on the high-volume read endpoints.
 */
export function sharedRateLimit({ name, max, windowSeconds }: Options): RequestHandler {
  const memory = rateLimit({
    windowMs: windowSeconds * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: TOO_MANY,
  });

  if (!redis) return memory;

  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(max, `${windowSeconds} s` as `${number} s`),
    prefix: `aatmabal:rl:${name}`,
  });

  return async (req, res, next) => {
    let result;
    try {
      result = await limiter.limit(req.ip ?? 'unknown');
    } catch (err) {
      console.error(`[rate-limit] Redis unavailable for "${name}", using the in-memory limiter`, err);
      return memory(req, res, next);
    }

    res.setHeader('RateLimit-Limit', String(result.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, result.remaining)));

    if (!result.success) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((result.reset - Date.now()) / 1000))));
      return res.status(429).json(TOO_MANY);
    }

    next();
  };
}
