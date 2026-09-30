import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { CACHE_KEYS, cached } from '../cache';
import { ensureAdminEditSchema, ensureLocationSchema, pool } from '../db';
import { adminOnly } from '../middleware/adminOnly';
import { asyncHandler } from '../middleware/asyncHandler';
import { invalidateCacheOnWrite } from '../middleware/invalidateCache';
import { buildSheet } from '../services/attendanceSheet';
import { buildAttendanceWorkbook } from '../services/exportAttendance';
import { attendanceFileName } from '../utils/fileName';
import { dateParam, idParam } from '../utils/validation';

const router = Router();
router.use(adminOnly);

// Any admin write (roles, sevaks, dates, allocations, marks) can change what sevaks see and what the
// attendance sheet shows, so all cached values are dropped after a successful write.
router.use(invalidateCacheOnWrite(CACHE_KEYS.activeControl, CACHE_KEYS.sheet));

const PG_UNIQUE_VIOLATION = '23505';

/** Collapses repeated spaces so "Ravi  Patil" and "Ravi Patil" count as the same name. */
const squash = (v: string) => v.replace(/\s+/g, ' ');

/** Runs `work` in a transaction, rolling back on any error. */
async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** A sevak that no longer belongs to any role is removed entirely. */
async function deleteOrphanSevaks(client: PoolClient): Promise<void> {
  await client.query(
    `DELETE FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)`,
  );
}

// =============================================================
// Roles & sevaks (deletes are permanent - no history is kept)
// =============================================================

router.get(
  '/roles',
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT r.id,
              r.name,
              COALESCE(
                json_agg(
                  json_build_object('id', u.id, 'firstName', u.first_name, 'lastName', u.last_name)
                  ORDER BY lower(u.first_name)
                ) FILTER (WHERE u.id IS NOT NULL),
                '[]'
              ) AS sevaks
         FROM roles r
         LEFT JOIN user_roles ur ON ur.role_id = r.id
         LEFT JOIN users u ON u.id = ur.user_id
        GROUP BY r.id
        ORDER BY r.name`,
    );
    res.json(rows);
  }),
);

router.post(
  '/roles',
  asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().trim().min(2).max(60) }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Invalid role name.' });
    }

    try {
      const { rows } = await pool.query('INSERT INTO roles (name) VALUES ($1) RETURNING *', [body.data.name]);
      res.json(rows[0]);
    } catch (err: any) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        return res.status(409).json({ message: 'Role already exists.' });
      }
      throw err;
    }
  }),
);

router.patch(
  '/roles/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = z.object({ name: z.string().trim().min(2).max(60) }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Invalid role name.' });
    }

    try {
      const result = await pool.query('UPDATE roles SET name = $1, updated_at = now() WHERE id = $2', [
        body.data.name,
        id,
      ]);
      if (!result.rowCount) {
        return res.status(404).json({ message: 'Role not found.' });
      }
      res.json({ ok: true });
    } catch (err: any) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        return res.status(409).json({ message: 'Role already exists.' });
      }
      throw err;
    }
  }),
);

router.delete(
  '/roles/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);

    await inTransaction(async (client) => {
      await client.query('DELETE FROM attendance WHERE role_id = $1', [id]);
      await client.query('DELETE FROM attendance_allocation WHERE role_id = $1', [id]);
      await client.query('DELETE FROM user_roles WHERE role_id = $1', [id]);
      await client.query('DELETE FROM roles WHERE id = $1', [id]);
      await deleteOrphanSevaks(client);
    });

    res.json({ ok: true });
  }),
);

router.post(
  '/roles/:id/sevaks',
  asyncHandler(async (req, res) => {
    const roleId = idParam.parse(req.params.id);
    const body = z
      .object({
        firstName: z.string().trim().min(1).max(50).transform(squash),
        lastName: z.string().trim().min(1).max(50).transform(squash),
      })
      .safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Invalid name.' });
    }

    const { firstName, lastName } = body.data;

    // A name can only ever be added once, across all seva roles.
    const existing = await pool.query(
      `SELECT COALESCE(string_agg(r.name, ', ' ORDER BY r.name), '') AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
        WHERE lower(u.first_name) = lower($1) AND lower(u.last_name) = lower($2)
        GROUP BY u.id`,
      [firstName, lastName],
    );
    if (existing.rowCount) {
      const where = existing.rows[0].roles ? ` in "${existing.rows[0].roles}"` : '';
      return res.status(409).json({ message: `${firstName} ${lastName} already exists${where}. Names must be unique.` });
    }

    try {
      await inTransaction(async (client) => {
        const user = await client.query(
          'INSERT INTO users (first_name, last_name) VALUES ($1, $2) RETURNING id',
          [firstName, lastName],
        );
        await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [user.rows[0].id, roleId]);
        res.json({ id: user.rows[0].id });
      });
    } catch (err: any) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        return res.status(409).json({ message: 'A sevak with this name already exists. Names must be unique.' });
      }
      throw err;
    }
  }),
);

router.delete(
  '/roles/:id/sevaks/:uid',
  asyncHandler(async (req, res) => {
    const roleId = idParam.parse(req.params.id);
    const userId = idParam.parse(req.params.uid);

    await inTransaction(async (client) => {
      await client.query('DELETE FROM attendance WHERE role_id = $1 AND user_id = $2', [roleId, userId]);
      await client.query('DELETE FROM attendance_allocation WHERE role_id = $1 AND user_id = $2', [roleId, userId]);
      await client.query('DELETE FROM user_roles WHERE role_id = $1 AND user_id = $2', [roleId, userId]);
      await deleteOrphanSevaks(client);
    });

    res.json({ ok: true });
  }),
);

router.patch(
  '/sevaks/:uid',
  asyncHandler(async (req, res) => {
    const userId = idParam.parse(req.params.uid);
    const body = z
      .object({
        firstName: z.string().trim().min(1).max(50).transform(squash),
        lastName: z.string().trim().min(1).max(50).transform(squash),
      })
      .safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Invalid name.' });
    }

    try {
      const result = await pool.query(
        'UPDATE users SET first_name = $1, last_name = $2, updated_at = now() WHERE id = $3',
        [body.data.firstName, body.data.lastName, userId],
      );
      if (!result.rowCount) {
        return res.status(404).json({ message: 'Sevak not found.' });
      }
      res.json({ ok: true });
    } catch (err: any) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        return res.status(409).json({ message: 'A sevak with this name already exists.' });
      }
      throw err;
    }
  }),
);

// Full attendance history for one sevak within one role: every date they were
// ever allocated (or marked SNA), with status/time/location for that date.
router.get(
  '/sevaks/:uid/roles/:rid/details',
  asyncHandler(async (req, res) => {
    const userId = idParam.parse(req.params.uid);
    const roleId = idParam.parse(req.params.rid);

    const { rows } = await pool.query(
      `SELECT to_char(c.attendance_date, 'DD-MM-YYYY') AS date,
              c.attendance_date AS sort_date,
              CASE WHEN a.allocation_status = 'SNA' THEN 'SNA'
                   WHEN t.id IS NOT NULL THEN 'Present'
                   ELSE 'Absent' END AS status,
              to_char(t.arrival_time, 'HH24:MI') AS in_time,
              t.marked_by_admin
         FROM attendance_allocation a
         JOIN attendance_control c ON c.id = a.attendance_control_id
         LEFT JOIN attendance t
                ON t.attendance_control_id = a.attendance_control_id
               AND t.user_id = a.user_id
               AND t.role_id = a.role_id
        WHERE a.user_id = $1
          AND a.role_id = $2
        ORDER BY c.attendance_date DESC`,
      [userId, roleId],
    );

    res.json(rows.map(({ sort_date, ...row }) => row));
  }),
);

// =============================================================
// Attendance control
// =============================================================

// Create a date; everyone with an active role defaults to ENABLED.
router.post(
  '/attendance/:date',
  asyncHandler(async (req, res) => {
    const date = dateParam.parse(req.params.date);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const control = await client.query(
        `INSERT INTO attendance_control (attendance_date)
         VALUES ($1)
         ON CONFLICT (attendance_date) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [date],
      );

      await client.query(
        `INSERT INTO attendance_allocation (attendance_control_id, user_id, role_id)
         SELECT $1, ur.user_id, ur.role_id
           FROM user_roles ur
         ON CONFLICT DO NOTHING`,
        [control.rows[0].id],
      );

      await client.query('COMMIT');
      res.json(control.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// All created dates, newest first, with whether each is active.
router.get(
  '/attendance-dates',
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT to_char(c.attendance_date, 'YYYY-MM-DD') AS date,
              c.is_active AS "isActive",
              (SELECT count(*)::int FROM attendance_allocation a
                WHERE a.attendance_control_id = c.id AND a.allocation_status = 'ENABLED') AS allocated,
              (SELECT count(*)::int FROM attendance t
                WHERE t.attendance_control_id = c.id) AS present
         FROM attendance_control c
        ORDER BY c.attendance_date DESC`,
    );
    res.json(rows);
  }),
);

// Permanently delete a date and every attendance record on it.
// The admin must retype the date (DD-MM-YYYY) as confirmation.
router.delete(
  '/attendance/:date',
  asyncHandler(async (req, res) => {
    const date = dateParam.parse(req.params.date);
    const confirm = z.string().parse(req.body?.confirm ?? '').trim();
    if (confirm !== date.split('-').reverse().join('-')) {
      return res.status(400).json({ message: 'The date you typed does not match.' });
    }

    const deleted = await inTransaction(async (client) => {
      const control = await client.query('SELECT id FROM attendance_control WHERE attendance_date = $1', [date]);
      if (!control.rowCount) return false;
      const id = control.rows[0].id;
      await client.query('DELETE FROM attendance WHERE attendance_control_id = $1', [id]);
      await client.query('DELETE FROM attendance_allocation WHERE attendance_control_id = $1', [id]);
      await client.query('DELETE FROM attendance_control WHERE id = $1', [id]);
      return true;
    });

    if (!deleted) return res.status(404).json({ message: 'That date does not exist.' });
    res.json({ ok: true });
  }),
);

// Admin correction from the Attendance Sheet: set one sevak's cell to P / A / SNA.
router.put(
  '/attendance/:date/mark',
  asyncHandler(async (req, res) => {
    const date = dateParam.parse(req.params.date);
    const body = z
      .object({
        userId: z.number().int().positive(),
        roleId: z.number().int().positive(),
        status: z.enum(['P', 'A', 'SNA']),
      })
      .safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Invalid input.' });
    }
    const { userId, roleId, status } = body.data;

    await ensureAdminEditSchema();

    const result = await inTransaction(async (client) => {
      const control = await client.query('SELECT id FROM attendance_control WHERE attendance_date = $1', [date]);
      if (!control.rowCount) return 'no-date' as const;
      const controlId = control.rows[0].id as number;

      const member = await client.query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, roleId]);
      if (!member.rowCount) return 'no-member' as const;

      await client.query(
        `INSERT INTO attendance_allocation (attendance_control_id, user_id, role_id, allocation_status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (attendance_control_id, user_id, role_id)
         DO UPDATE SET allocation_status = EXCLUDED.allocation_status`,
        [controlId, userId, roleId, status === 'SNA' ? 'SNA' : 'ENABLED'],
      );

      if (status === 'P') {
        await client.query(
          `INSERT INTO attendance (attendance_control_id, user_id, role_id, marked_by_admin)
           VALUES ($1, $2, $3, true)
           ON CONFLICT (attendance_control_id, user_id, role_id) DO NOTHING`,
          [controlId, userId, roleId],
        );
      } else {
        await client.query(
          'DELETE FROM attendance WHERE attendance_control_id = $1 AND user_id = $2 AND role_id = $3',
          [controlId, userId, roleId],
        );
      }
      return 'ok' as const;
    });

    if (result === 'no-date') return res.status(404).json({ message: 'That date does not exist.' });
    if (result === 'no-member') return res.status(404).json({ message: 'Sevak is not in this role.' });
    res.json({ ok: true });
  }),
);

// Which dates are currently active (at most one - enforced by a unique index).
router.get(
  '/active-attendance',
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT to_char(attendance_date, 'YYYY-MM-DD') AS date
         FROM attendance_control
        WHERE is_active
        ORDER BY attendance_date`,
    );
    res.json(rows.map((r) => r.date as string));
  }),
);

router.get(
  '/attendance/:date',
  asyncHandler(async (req, res) => {
    const date = dateParam.parse(req.params.date);

    const control = await pool.query(
      'SELECT id, is_active FROM attendance_control WHERE attendance_date = $1',
      [date],
    );
    if (!control.rowCount) {
      return res.json({ exists: false, isActive: false, rows: [] });
    }

    const { rows } = await pool.query(
      `SELECT a.user_id,
              a.role_id,
              u.first_name,
              u.last_name,
              r.name AS role,
              a.allocation_status
         FROM attendance_allocation a
         JOIN users u ON u.id = a.user_id
         JOIN roles r ON r.id = a.role_id
        WHERE a.attendance_control_id = $1
        ORDER BY r.name, r.id, lower(u.first_name), lower(u.last_name)`,
      [control.rows[0].id],
    );

    res.json({ exists: true, isActive: control.rows[0].is_active as boolean, rows });
  }),
);

router.patch(
  '/attendance/:date/allocation',
  asyncHandler(async (req, res) => {
    const date = dateParam.parse(req.params.date);
    const body = z
      .object({
        userId: z.number().int().positive(),
        roleId: z.number().int().positive(),
        status: z.enum(['ENABLED', 'SNA']),
      })
      .parse(req.body);

    const result = await pool.query(
      `UPDATE attendance_allocation
          SET allocation_status = $1
        WHERE user_id = $2
          AND role_id = $3
          AND attendance_control_id = (SELECT id FROM attendance_control WHERE attendance_date = $4)`,
      [body.status, body.userId, body.roleId, date],
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: 'Allocation not found.' });
    }
    res.json({ ok: true });
  }),
);

router.patch(
  '/attendance/:date/active',
  asyncHandler(async (req, res) => {
    const date = dateParam.parse(req.params.date);
    const active = z.boolean().parse(req.body?.active);

    if (active) {
      // Only one date may be active at a time: a forgotten older date must be deactivated first.
      const others = await pool.query(
        `SELECT to_char(attendance_date, 'YYYY-MM-DD') AS date
           FROM attendance_control
          WHERE is_active AND attendance_date <> $1
          ORDER BY attendance_date`,
        [date],
      );
      if (others.rowCount) {
        return res.status(409).json({
          message: 'Another date is still active. Deactivate it first.',
          activeDates: others.rows.map((r) => r.date as string),
        });
      }
    }

    try {
      const result = await pool.query(
        'UPDATE attendance_control SET is_active = $1, updated_at = now() WHERE attendance_date = $2',
        [active, date],
      );

      if (!result.rowCount) {
        return res.status(404).json({ message: 'That date has not been created yet.' });
      }
      res.json({ ok: true });
    } catch (err: any) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        return res.status(409).json({ message: 'Another date is still active. Deactivate it first.' });
      }
      throw err;
    }
  }),
);

// =============================================================
// Attendance locations (sevaks can only mark attendance inside one of these)
// =============================================================

const LocationBody = z.object({
  name: z.string().trim().min(2).max(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // Stored in metres; the admin may type it in m or km (converted by the form).
  radiusM: z.number().min(10).max(50_000),
});

const LOCATION_COLUMNS = `id, name, latitude, longitude, radius_m AS "radiusM", is_active AS "isActive"`;
const LAST_ACTIVE =
  'At least one location must stay enabled, otherwise sevaks cannot mark attendance. Enable another location first.';

router.get(
  '/locations',
  asyncHandler(async (_req, res) => {
    await ensureLocationSchema();
    const { rows } = await pool.query(`SELECT ${LOCATION_COLUMNS} FROM attendance_locations ORDER BY id`);
    res.json(rows);
  }),
);

router.post(
  '/locations',
  asyncHandler(async (req, res) => {
    await ensureLocationSchema();
    const body = LocationBody.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Please enter a valid name, latitude, longitude and radius.' });
    }
    const d = body.data;

    try {
      const { rows } = await pool.query(
        `INSERT INTO attendance_locations (name, latitude, longitude, radius_m)
         VALUES ($1, $2, $3, $4)
         RETURNING ${LOCATION_COLUMNS}`,
        [squash(d.name), d.latitude, d.longitude, d.radiusM],
      );
      res.json(rows[0]);
    } catch (err: any) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        return res.status(409).json({ message: 'A location with this name already exists.' });
      }
      throw err;
    }
  }),
);

router.patch(
  '/locations/:id',
  asyncHandler(async (req, res) => {
    await ensureLocationSchema();
    const id = idParam.parse(req.params.id);
    const body = LocationBody.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Please enter a valid name, latitude, longitude and radius.' });
    }
    const d = body.data;

    try {
      const result = await pool.query(
        `UPDATE attendance_locations
            SET name = $1, latitude = $2, longitude = $3, radius_m = $4, updated_at = now()
          WHERE id = $5`,
        [squash(d.name), d.latitude, d.longitude, d.radiusM, id],
      );
      if (!result.rowCount) {
        return res.status(404).json({ message: 'Location not found.' });
      }
      res.json({ ok: true });
    } catch (err: any) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        return res.status(409).json({ message: 'A location with this name already exists.' });
      }
      throw err;
    }
  }),
);

// Turn one location on or off. At least one must stay on.
router.patch(
  '/locations/:id/active',
  asyncHandler(async (req, res) => {
    await ensureLocationSchema();
    const id = idParam.parse(req.params.id);
    const active = z.boolean().parse(req.body?.active);

    const result = active
      ? await pool.query('UPDATE attendance_locations SET is_active = true, updated_at = now() WHERE id = $1', [id])
      : await pool.query(
          `UPDATE attendance_locations
              SET is_active = false, updated_at = now()
            WHERE id = $1
              AND (is_active = false OR EXISTS (
                    SELECT 1 FROM attendance_locations WHERE is_active AND id <> $1))`,
          [id],
        );

    if (!result.rowCount) {
      const exists = await pool.query('SELECT 1 FROM attendance_locations WHERE id = $1', [id]);
      return exists.rowCount
        ? res.status(409).json({ message: LAST_ACTIVE })
        : res.status(404).json({ message: 'Location not found.' });
    }
    res.json({ ok: true });
  }),
);

router.delete(
  '/locations/:id',
  asyncHandler(async (req, res) => {
    await ensureLocationSchema();
    const id = idParam.parse(req.params.id);

    // Deleting must not leave zero enabled locations.
    const result = await pool.query(
      `DELETE FROM attendance_locations
        WHERE id = $1
          AND (NOT is_active OR EXISTS (
                SELECT 1 FROM attendance_locations WHERE is_active AND id <> $1))`,
      [id],
    );
    if (!result.rowCount) {
      const exists = await pool.query('SELECT 1 FROM attendance_locations WHERE id = $1', [id]);
      return exists.rowCount
        ? res.status(409).json({ message: LAST_ACTIVE })
        : res.status(404).json({ message: 'Location not found.' });
    }
    res.json({ ok: true });
  }),
);

// =============================================================
// Attendance sheet (JSON for the admin page)
// =============================================================

router.get(
  '/sheet',
  asyncHandler(async (_req, res) => {
    // Heavy query; cached for 60s and dropped by any write. The Excel export below always reads fresh.
    res.json(await cached(CACHE_KEYS.sheet, 60, buildSheet));
  }),
);

// =============================================================
// Excel export
// =============================================================

router.get(
  '/export',
  asyncHandler(async (_req, res) => {
    const workbook = await buildAttendanceWorkbook();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${attendanceFileName()}"`);

    await workbook.xlsx.write(res);
    res.end();
  }),
);

export default router;
