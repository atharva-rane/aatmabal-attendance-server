import { isCacheEnabled, redis } from './cache';

/** `npm run check-redis` - proves the Upstash credentials work (write, read, delete). */
async function main(): Promise<void> {
  if (!redis || !isCacheEnabled) {
    console.error('Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in server/.env');
    process.exitCode = 1;
    return;
  }

  const key = 'aatmabal:check';
  const started = Date.now();

  await redis.set(key, { hello: 'aatmabal' }, { ex: 30 });
  const value = await redis.get<{ hello: string }>(key);
  await redis.del(key);

  if (value?.hello !== 'aatmabal') {
    throw new Error(`Unexpected value read back: ${JSON.stringify(value)}`);
  }

  console.log(`Redis OK - write, read and delete worked (${Date.now() - started} ms round trip).`);
}

main().catch((err) => {
  console.error('Redis check failed:', err);
  process.exitCode = 1;
});
