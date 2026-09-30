-- Aatmabal schema (PostgreSQL / Neon). Safe to re-run.
-- Existing database? Run migrations/001_hard_delete.sql, 002_admin_attendance_edit.sql and 003_attendance_locations.sql and 004_location_enable.sql once.

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_name_uq
    ON users (lower(first_name), lower(last_name));

CREATE INDEX IF NOT EXISTS users_first_idx
    ON users (lower(first_name) text_pattern_ops);


CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS roles_name_uq
    ON roles (lower(name));


CREATE TABLE IF NOT EXISTS user_roles (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users ON DELETE RESTRICT,
    role_id INT NOT NULL REFERENCES roles ON DELETE RESTRICT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS user_roles_role_idx
    ON user_roles (role_id);


CREATE TABLE IF NOT EXISTS attendance_control (
    id SERIAL PRIMARY KEY,
    attendance_date DATE NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);


-- Only one date can be active at a time.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_control_one_active
    ON attendance_control (is_active)
    WHERE is_active;


CREATE TABLE IF NOT EXISTS attendance_allocation (
    id SERIAL PRIMARY KEY,
    attendance_control_id INT NOT NULL REFERENCES attendance_control,
    user_id INT NOT NULL REFERENCES users,
    role_id INT NOT NULL REFERENCES roles,
    allocation_status TEXT NOT NULL DEFAULT 'ENABLED'
        CHECK (allocation_status IN ('ENABLED', 'SNA')),
    UNIQUE (attendance_control_id, user_id, role_id)
);

CREATE INDEX IF NOT EXISTS attendance_allocation_user_idx
    ON attendance_allocation (user_id);


CREATE TABLE IF NOT EXISTS attendance (
    id SERIAL PRIMARY KEY,
    attendance_control_id INT NOT NULL REFERENCES attendance_control,
    user_id INT NOT NULL REFERENCES users,
    role_id INT NOT NULL REFERENCES roles,
    arrival_time TIME,
    status TEXT NOT NULL DEFAULT 'PRESENT',
    marked_by_admin BOOLEAN NOT NULL DEFAULT false,
    submitted_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (attendance_control_id, user_id, role_id)
);


CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
);


-- Places where sevaks may mark attendance (each is a centre point + radius in metres).
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

-- Starting locations (only when the table is empty).
INSERT INTO attendance_locations (name, latitude, longitude, radius_m)
SELECT v.name, v.latitude, v.longitude, v.radius_m
  FROM (VALUES
         ('SHGG',      19.067874::double precision, 72.849776::double precision, 500::double precision),
         ('Sai Niwas', 19.058658::double precision, 72.835358::double precision, 300::double precision)
       ) AS v(name, latitude, longitude, radius_m)
 WHERE NOT EXISTS (SELECT 1 FROM attendance_locations)
ON CONFLICT DO NOTHING;
