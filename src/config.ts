import { requireEnv } from './env';

const PLACEHOLDER_SECRET = 'change-me-long-random';

const isProduction = process.env.NODE_ENV === 'production';
const jwtSecret = requireEnv('JWT_SECRET');

if (jwtSecret === PLACEHOLDER_SECRET) {
  if (isProduction) {
    throw new Error('JWT_SECRET is still the placeholder value. Set a long random secret.');
  }

  console.warn('[config] JWT_SECRET is the placeholder value. Change it before deploying.');
}

// CLIENT_ORIGIN may hold several comma-separated origins, e.g. the production URL and a custom domain.
const clientOrigins = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

export const config = {
  isProduction,
  port: Number(process.env.PORT) || 4000,
  clientOrigins,
  jwtSecret,
} as const;
