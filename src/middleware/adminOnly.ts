import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export function adminOnly(req: Request, res: Response, next: NextFunction): void {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

  try {
    jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ message: 'Please log in again.' });
  }
}
