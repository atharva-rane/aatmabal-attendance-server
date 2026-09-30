-- Geofenced attendance: sevaks can only mark attendance inside one of the admin's locations.
-- 1) Creates attendance_locations and seeds the two starting locations (only if the table is empty).
-- 2) Stops recording sevak coordinates: drops the old latitude / longitude / accuracy columns.
--    (Any coordinates already stored are permanently deleted.)
-- Safe to run more than once.
BEGIN;

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

CREATE UNIQUE INDEX IF NOT EXISTS attendance_locations_name_uq
    ON attendance_locations (lower(name));

INSERT INTO attendance_locations (name, latitude, longitude, radius_m)
SELECT v.name, v.latitude, v.longitude, v.radius_m
  FROM (VALUES
         ('SHGG',      19.067874::double precision, 72.849776::double precision, 500::double precision),
         ('Sai Niwas', 19.058658::double precision, 72.835358::double precision, 300::double precision)
       ) AS v(name, latitude, longitude, radius_m)
 WHERE NOT EXISTS (SELECT 1 FROM attendance_locations)
ON CONFLICT DO NOTHING;

ALTER TABLE attendance DROP COLUMN IF EXISTS latitude;
ALTER TABLE attendance DROP COLUMN IF EXISTS longitude;
ALTER TABLE attendance DROP COLUMN IF EXISTS location_accuracy;
ALTER TABLE attendance DROP COLUMN IF EXISTS location_captured_at;

COMMIT;
