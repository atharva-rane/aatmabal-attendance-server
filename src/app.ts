import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { isCacheEnabled } from './cache';
import { config } from './config';
import { errorHandler, notFound } from './middleware/errorHandler';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import publicRoutes from './routes/public';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(
  cors({
    origin: config.clientOrigins,
    // Lets browsers remember the preflight answer (Chrome caps this at 2h) so admin calls aren't doubled.
    maxAge: 7200,
  }),
);
app.use(express.json({ limit: '20kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, cache: isCacheEnabled ? 'redis' : 'disabled' });
});

app.use('/api/admin', authRoutes); // POST /api/admin/login (public)
app.use('/api/admin', adminRoutes); // everything else under /api/admin requires a token
app.use('/api/public', publicRoutes);

app.use('/api', notFound);
app.use(errorHandler);

// Vercel runs this file as a serverless function and uses the default export below.
// Locally (`npm run dev`) we start a normal HTTP server.
if (!process.env.VERCEL) {
  app.listen(config.port, () => {
    console.log(`API listening on http://localhost:${config.port}`);
  });
}

export default app;
