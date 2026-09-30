-- 004_location_enable.sql
-- Sets up attendance locations with an On/Off switch per location.
-- Safe to run on any database state and safe to re-run.

BEGIN;

-- 1) Locations table (created only if missing)
CREATE TABLE IF NOT EXISTS attendance_locations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    radius_m DOUBLE PRECISION NOT NULL CHECK (radius_m > 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2) On/Off column for databases that already had the table (existing rows stay ON)
ALTER TABLE attendance_locations
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS attendance_locations_name_uq
    ON attendance_locations (lower(name));

-- 3) Starting locations (only when the table is empty)
INSERT INTO attendance_locations (name, latitude, longitude, radius_m)
SELECT v.name, v.latitude, v.longitude, v.radius_m
  FROM (VALUES
         ('SHGG',      19.067874::double precision, 72.849776::double precision, 500::double precision),
         ('Sai Niwas', 19.058658::double precision, 72.835358::double precision, 300::double precision)
       ) AS v(name, latitude, longitude, radius_m)
 WHERE NOT EXISTS (SELECT 1 FROM attendance_locations);

-- 4) Stop storing sevak coordinates: drop the old columns only if they still exist
DO $$
DECLARE
  col text;
BEGIN
  FOREACH col IN ARRAY ARRAY['latitude', 'longitude', 'location_accuracy', 'location_captured_at']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'attendance'
         AND column_name = col
    ) THEN
      EXECUTE format('ALTER TABLE attendance DROP COLUMN %I', col);
    END IF;
  END LOOP;
END $$;

COMMIT;