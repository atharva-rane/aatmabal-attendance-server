import { z } from 'zod';

/** True only for real calendar dates (rejects e.g. 2026-13-45 or 2026-02-30). */
const isRealDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const idParam = z.coerce.number().int().positive();

export const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealDate, 'Invalid date');
