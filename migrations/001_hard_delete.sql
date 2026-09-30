-- One-time migration for an EXISTING database.
-- 1) Permanently removes everything that was previously only "soft deleted".
-- 2) Drops the deleted_at / removed_at columns (deletes are now permanent).
-- 3) Allows only one active attendance date at a time.
-- Safe to run more than once. New installs only need schema.sql.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'roles' AND column_name = 'deleted_at') THEN

    -- Attendance + allocations of deleted roles / removed sevaks
    DELETE FROM attendance
     WHERE role_id IN (SELECT id FROM roles WHERE deleted_at IS NOT NULL)
        OR (user_id, role_id) IN (SELECT user_id, role_id FROM user_roles WHERE removed_at IS NOT NULL);

    DELETE FROM attendance_allocation
     WHERE role_id IN (SELECT id FROM roles WHERE deleted_at IS NOT NULL)
        OR (user_id, role_id) IN (SELECT user_id, role_id FROM user_roles WHERE removed_at IS NOT NULL);

    DELETE FROM user_roles
     WHERE removed_at IS NOT NULL
        OR role_id IN (SELECT id FROM roles WHERE deleted_at IS NOT NULL);

    DELETE FROM roles WHERE deleted_at IS NOT NULL;

    -- Sevaks that belong to no role any more
    DELETE FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id);

    DROP INDEX IF EXISTS roles_name_uq;
    ALTER TABLE roles DROP COLUMN deleted_at;
    ALTER TABLE user_roles DROP COLUMN removed_at;
    CREATE UNIQUE INDEX IF NOT EXISTS roles_name_uq ON roles (lower(name));
  END IF;
END $$;

-- Keep only the most recent active date, then enforce "one active date".
UPDATE attendance_control
   SET is_active = false
 WHERE is_active
   AND id <> (SELECT id FROM attendance_control WHERE is_active ORDER BY attendance_date DESC LIMIT 1);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_control_one_active
    ON attendance_control (is_active)
    WHERE is_active;

COMMIT;
