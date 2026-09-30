import { Pool } from 'pg';
import { requireEnv } from './env';

// Every serverless instance owns its own pool, so keep it small there and use Neon's
// *pooled* connection string (host contains "-pooler") to avoid running out of connections.
const poolSize = Number(process.env.DB_POOL_MAX) || (process.env.VERCEL ? 3 : 10);

export const pool = new Pool({
  connectionString: requireEnv('NEON_DATABASE_URL'),
  max: poolSize,
  idleTimeoutMillis: 30_000,
  ssl: { rejectUnauthorized: true },
});

// An idle client erroring must not crash the process.
pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle client', err);
});

/** Today's date in India Standard Time, formatted as YYYY-MM-DD. */
export const todayIST = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

let adminEditSchema: Promise<void> | null = null;

/**
 * Admin-marked Present rows have no arrival time or location, so those columns
 * must be nullable. Same as migrations/002; safe to repeat, and runs at most once
 * per server process so the admin never has to apply it by hand.
 */
export function ensureAdminEditSchema(): Promise<void> {
  adminEditSchema ??= (async () => {
    await pool.query('ALTER TABLE attendance ALTER COLUMN arrival_time DROP NOT NULL');
    // Older databases may still have the (now unused) coordinate columns; they must not block inserts.
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'attendance' AND column_name = 'latitude') THEN
          ALTER TABLE attendance ALTER COLUMN latitude DROP NOT NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'attendance' AND column_name = 'longitude') THEN
          ALTER TABLE attendance ALTER COLUMN longitude DROP NOT NULL;
        END IF;
      END $$;
    `);
    await pool.query('ALTER TABLE attendance ADD COLUMN IF NOT EXISTS marked_by_admin BOOLEAN NOT NULL DEFAULT false');
  })().catch((err) => {
    adminEditSchema = null; // retry on the next request
    throw err;
  });
  return adminEditSchema;
}

let locationSchema: Promise<void> | null = null;

/**
 * Creates the attendance_locations table (same as migrations/003) and seeds the two starting
 * locations, but only when the table is created here - so a location the admin deleted never
 * comes back. Runs at most once per server process.
 */
export function ensureLocationSchema(): Promise<void> {
  locationSchema ??= (async () => {
    await ensureAdminEditSchema();

    const { rows } = await pool.query(`SELECT to_regclass('attendance_locations') AS t`);
    const existed = rows[0].t !== null;

    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance_locations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
        longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
        radius_m DOUBLE PRECISION NOT NULL CHECK (radius_m > 0),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      )`);
    await pool.query('ALTER TABLE attendance_locations ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true');
    await pool.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS attendance_locations_name_uq ON attendance_locations (lower(name))',
    );

    if (!existed) {
      await pool.query(`
        INSERT INTO attendance_locations (name, latitude, longitude, radius_m)
        VALUES ('SHGG', 19.067874, 72.849776, 500),
               ('Sai Niwas', 19.058658, 72.835358, 300)
        ON CONFLICT DO NOTHING`);
    }
  })().catch((err) => {
    locationSchema = null; // retry on the next request
    throw err;
  });
  return locationSchema;
}
