import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { CACHE_KEYS, cached, invalidateCache } from '../cache';
import { ensureLocationSchema, pool } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { sharedRateLimit } from '../middleware/rateLimit';
import { distanceMeters, formatDistance } from '../utils/geo';
import { idParam } from '../utils/validation';

const router = Router();

const NOT_ALLOCATED = 'No seva allocated to you today, Ambadnya.';
const ALREADY_MARKED = 'Your attendance is already marked.';
const NOT_ACTIVE = 'Wait for admin to activate the attendance.';
const MAX_LOCATION_AGE_MS = 5 * 60_000;
/** A GPS fix less precise than this cannot be trusted to place someone inside a radius. */
const MAX_ACCURACY_M = 150;
const NO_LOCATION_SET = 'No attendance location is enabled right now. Please contact the admin.';
const WEAK_SIGNAL =
  'Your location could not be determined accurately. Please move to an open area, check that GPS is on, and try again.';

const limiter = (max: number) =>
  rateLimit({ windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false });

type ActiveControl = { id: number; is_active: boolean; date: string };

/** Always asks the database. */
async function loadActiveControl(): Promise<ActiveControl | null> {
  const { rows } = await pool.query(
    `SELECT id, is_active, to_char(attendance_date, 'YYYY-MM-DD') AS date
       FROM attendance_control
      WHERE is_active
      LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * The date the admin has activated (the DB allows at most one), or null when none is active.
 *
 * Every sevak request needs this, so it is served from Redis for up to 30s. The admin routes
 * drop the cached value the moment a date is created, activated, deactivated or deleted, so in
 * practice it is never stale. Pass `{ fresh: true }` to skip the cache (used when saving attendance).
 */
function getActiveControl({ fresh = false } = {}): Promise<ActiveControl | null> {
  return fresh ? loadActiveControl() : cached(CACHE_KEYS.activeControl, 30, loadActiveControl);
}

// ---- Which date is open for attendance? (the Mark Attendance form only opens when one is)
router.get(
  '/status',
  limiter(120),
  asyncHandler(async (_req, res) => {
    const control = await getActiveControl();
    res.json({ active: Boolean(control), date: control?.date ?? null });
  }),
);

// ---- Name search (debounced on the client, max 8 rows)
router.get(
  '/sevaks',
  limiter(120),
  asyncHandler(async (req, res) => {
    const term = String(req.query.q ?? '').trim().slice(0, 40);
    if (term.length < 2) {
      return res.json([]);
    }

    // Strip LIKE wildcards / escape characters so user input is matched literally.
    const pattern = `%${term.replace(/[%_\\]/g, '')}%`;

    // Any sevak can be picked while a date is active; the allocation check below
    // tells them whether they have seva today or have already marked attendance.
    const control = await getActiveControl();
    if (!control) {
      return res.json([]);
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name
         FROM users u
        WHERE lower(u.first_name || ' ' || u.last_name) LIKE lower($1)
        ORDER BY u.first_name, u.last_name
        LIMIT 8`,
      [pattern],
    );

    res.json(rows);
  }),
);

// ---- Roles a sevak can still mark attendance for on the active date
router.get(
  '/allocation/:userId',
  limiter(120),
  asyncHandler(async (req, res) => {
    const userId = idParam.safeParse(req.params.userId);
    if (!userId.success) {
      return res.status(400).json({ message: 'Invalid input.' });
    }

    const control = await getActiveControl();
    if (!control?.is_active) {
      return res.status(409).json({ message: NOT_ACTIVE });
    }

    // Every ENABLED role for this sevak today, and whether attendance is already marked for it.
    const { rows } = await pool.query(
      `SELECT r.id,
              r.name,
              EXISTS (
                SELECT 1 FROM attendance t
                 WHERE t.attendance_control_id = a.attendance_control_id
                   AND t.user_id = a.user_id
                   AND t.role_id = a.role_id
              ) AS marked
         FROM attendance_allocation a
         JOIN roles r ON r.id = a.role_id
        WHERE a.attendance_control_id = $1
          AND a.user_id = $2
          AND a.allocation_status = 'ENABLED'
        ORDER BY r.name`,
      [control.id, userId.data],
    );

    if (!rows.length) {
      return res.status(403).json({ message: NOT_ALLOCATED });
    }

    const pending = rows.filter((r) => !r.marked).map((r) => ({ id: r.id, name: r.name }));
    if (!pending.length) {
      return res.json({ roles: [], alreadyMarked: true, message: ALREADY_MARKED });
    }

    res.json({ roles: pending });
  }),
);

// ---- Submit attendance
const SubmitBody = z.object({
  userId: z.number().int().positive(),
  roleId: z.number().int().positive(),
  arrivalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().positive().max(100_000),
  locationTimestamp: z.number().int().positive(),
});

router.post(
  '/attendance',
  sharedRateLimit({ name: 'attendance-submit', max: 30, windowSeconds: 60 }),
  asyncHandler(async (req, res) => {
    const body = SubmitBody.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Please check the details and try again.' });
    }
    const d = body.data;

    if (Math.abs(Date.now() - d.locationTimestamp) > MAX_LOCATION_AGE_MS) {
      return res.status(400).json({ message: 'Location is outdated. Please retry.' });
    }

    // Writes never trust the cache: check the database directly.
    const control = await getActiveControl({ fresh: true });
    if (!control?.is_active) {
      return res.status(409).json({ message: NOT_ACTIVE });
    }

    const allocation = await pool.query(
      `SELECT 1
         FROM attendance_allocation a
         JOIN roles r ON r.id = a.role_id
        WHERE a.attendance_control_id = $1
          AND a.user_id = $2
          AND a.role_id = $3
          AND a.allocation_status = 'ENABLED'`,
      [control.id, d.userId, d.roleId],
    );
    if (!allocation.rowCount) {
      return res.status(403).json({ message: NOT_ALLOCATED });
    }

    // The sevak must be inside the radius of at least one admin-approved location. The coordinates
    // are used only for this check and are never stored.
    await ensureLocationSchema();
    const { rows: locations } = await pool.query(
      'SELECT name, latitude, longitude, radius_m FROM attendance_locations WHERE is_active',
    );
    if (!locations.length) {
      return res.status(409).json({ message: NO_LOCATION_SET });
    }
    if (d.accuracy > MAX_ACCURACY_M) {
      return res.status(400).json({ message: WEAK_SIGNAL });
    }

    let nearest: { name: string; distance: number; radius: number; gap: number } | null = null;
    for (const loc of locations) {
      const distance = distanceMeters(d.latitude, d.longitude, loc.latitude, loc.longitude);
      if (distance <= loc.radius_m) {
        nearest = null;
        break;
      }
      const gap = distance - loc.radius_m;
      if (!nearest || gap < nearest.gap) {
        nearest = { name: loc.name, distance, radius: loc.radius_m, gap };
      }
    }
    if (nearest) {
      return res.status(403).json({
        message:
          `You are ${formatDistance(Math.ceil(nearest.distance))} away from ${nearest.name}. ` +
          `Please come within ${formatDistance(nearest.radius)} of the location to mark your attendance.`,
      });
    }

    const inserted = await pool.query(
      `INSERT INTO attendance (attendance_control_id, user_id, role_id, arrival_time)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (attendance_control_id, user_id, role_id) DO NOTHING`,
      [control.id, d.userId, d.roleId, d.arrivalTime],
    );
    if (!inserted.rowCount) {
      return res.status(409).json({ message: 'Your attendance has already been marked.' });
    }

    // A new Present row changes the admin sheet.
    await invalidateCache(CACHE_KEYS.sheet);

    res.json({ message: 'Attendance marked successfully.' });
  }),
);

export default router;
