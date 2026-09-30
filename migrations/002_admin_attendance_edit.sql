-- Lets the admin mark a sevak Present from the Attendance Sheet without a
-- sevak-submitted location/time. Safe to run more than once.
BEGIN;
ALTER TABLE attendance ALTER COLUMN arrival_time DROP NOT NULL;
ALTER TABLE attendance ALTER COLUMN latitude DROP NOT NULL;
ALTER TABLE attendance ALTER COLUMN longitude DROP NOT NULL;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS marked_by_admin BOOLEAN NOT NULL DEFAULT false;
COMMIT;
