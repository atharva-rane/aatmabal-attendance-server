import bcrypt from 'bcryptjs';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config';
import { pool } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { sharedRateLimit } from '../middleware/rateLimit';

const router = Router();

// Compared against when the username does not exist, so response time
// does not reveal which usernames are valid.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

// 10 attempts per 15 minutes per IP, counted in Redis so it holds across all server instances.
const loginLimiter = sharedRateLimit({ name: 'admin-login', max: 10, windowSeconds: 15 * 60 });

const LoginBody = z.object({
  username: z.string().max(60),
  password: z.string().max(200),
});

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Invalid input.' });
    }

    const { rows } = await pool.query('SELECT id, password_hash FROM admins WHERE username = $1', [
      body.data.username,
    ]);
    const admin = rows[0];

    const passwordOk = await bcrypt.compare(body.data.password, admin?.password_hash ?? DUMMY_HASH);
    if (!admin || !passwordOk) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const token = jwt.sign({ id: admin.id }, config.jwtSecret, { expiresIn: '2h' });
    res.json({ token });
  }),
);

export default router;
