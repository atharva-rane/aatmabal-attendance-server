import { pool } from '../db';

/** P = present, A = absent, SNA = seva not allocated, PENDING = today's open date, - = not part of that date. */
export type Cell = 'P' | 'A' | 'SNA' | 'PENDING' | '-';

export type SheetRole = {
  roleId: number;
  role: string;
  dates: Array<{ iso: string; label: string }>;
  sevaks: Array<{ id: number; name: string; cells: Cell[]; percentage: number }>;
};

type Row = {
  rid: number;
  role: string;
  uid: number | null;
  full: string | null;
  iso: string | null;
  st: Exclude<Cell, '-'> | null;
};

const toLabel = (iso: string) => iso.split('-').reverse().join('-'); // YYYY-MM-DD -> DD-MM-YYYY

/**
 * One block per role: a column for every date that role had seva on, and a row per sevak.
 * SNA days and a date that is still open (PENDING) are left out of the percentage.
 */
export async function buildSheet(): Promise<SheetRole[]> {
  const { rows } = await pool.query<Row>(
    `SELECT r.id AS rid,
            r.name AS role,
            u.id AS uid,
            u.first_name || ' ' || u.last_name AS full,
            to_char(c.attendance_date, 'YYYY-MM-DD') AS iso,
            CASE WHEN c.id IS NULL THEN NULL
                 WHEN a.allocation_status = 'SNA' THEN 'SNA'
                 WHEN t.id IS NOT NULL THEN 'P'
                 WHEN c.is_active THEN 'PENDING'
                 ELSE 'A' END AS st
       FROM roles r
       LEFT JOIN user_roles ur ON ur.role_id = r.id
       LEFT JOIN users u ON u.id = ur.user_id
       LEFT JOIN attendance_allocation a ON a.user_id = u.id AND a.role_id = r.id
       LEFT JOIN attendance_control c ON c.id = a.attendance_control_id
       LEFT JOIN attendance t
              ON t.attendance_control_id = a.attendance_control_id
             AND t.user_id = a.user_id
             AND t.role_id = a.role_id
      ORDER BY r.name, r.id, lower(u.first_name), lower(u.last_name), u.id, c.attendance_date`,
  );

  type RoleAcc = {
    role: string;
    dates: Set<string>;
    sevaks: Map<number, { name: string; byDate: Map<string, Exclude<Cell, '-'>> }>;
  };
  const roles = new Map<number, RoleAcc>();

  for (const row of rows) {
    let acc = roles.get(row.rid);
    if (!acc) {
      acc = { role: row.role, dates: new Set(), sevaks: new Map() };
      roles.set(row.rid, acc);
    }
    if (row.uid == null) continue;

    let sevak = acc.sevaks.get(row.uid);
    if (!sevak) {
      sevak = { name: row.full ?? '', byDate: new Map() };
      acc.sevaks.set(row.uid, sevak);
    }
    if (row.iso && row.st) {
      acc.dates.add(row.iso);
      sevak.byDate.set(row.iso, row.st);
    }
  }

  return [...roles.entries()].map(([roleId, acc]) => {
    const isoDates = [...acc.dates].sort();

    const sevaks = [...acc.sevaks.entries()].map(([id, s]) => {
      const cells: Cell[] = isoDates.map((iso) => s.byDate.get(iso) ?? '-');
      const present = cells.filter((c) => c === 'P').length;
      const expected = cells.filter((c) => c === 'P' || c === 'A').length;
      return { id, name: s.name, cells, percentage: expected ? Math.round((present / expected) * 100) : 0 };
    });

    return {
      roleId,
      role: acc.role,
      dates: isoDates.map((iso) => ({ iso, label: toLabel(iso) })),
      sevaks,
    };
  });
}
