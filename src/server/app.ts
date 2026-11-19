import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { initDatabase, uploadsDir } from './db.ts';
import { apiRouter } from './routes.ts';
import { ensureSupabaseAdminBootstrap, isSupabaseConfigured } from './supabase.ts';

dotenv.config();

let initialized = false;
let initPromise: Promise<void> | null = null;

export async function ensureBackendInitialized() {
  if (initialized) return;
  if (!initPromise) {
    initPromise = (async () => {
      if (process.env.VERCEL && !isSupabaseConfigured()) {
        throw new Error('CONFIGURAÇÃO OBRIGATÓRIA DO SUPABASE AUSENTE: Na Vercel, SUPABASE_URL e SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY devem estar configuradas.');
      }
      if (!isSupabaseConfigured()) {
        initDatabase();
      }
      if (isSupabaseConfigured()) {
        await ensureSupabaseAdminBootstrap();
      }
      initialized = true;
    })();
  }
  await initPromise;
}

export function createExpressApp() {
  const app = express();

  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(cookieParser());
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(async (_req, _res, next) => {
    try {
      await ensureBackendInitialized();
      next();
    } catch (err) {
      next(err);
    }
  });

  app.use(
    '/uploads/produtos',
    express.static(uploadsDir, {
      maxAge: '7d',
      dotfiles: 'deny',
    })
  );

  app.use(
    '/uploads',
    express.static(path.resolve(process.env.VERCEL ? '/tmp/agro-marconato' : process.cwd(), 'uploads'), {
      maxAge: '7d',
      dotfiles: 'deny',
    })
  );

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'agro-marconato',
      database: isSupabaseConfigured() ? 'supabase' : 'sqlite-local',
    });
  });

  app.use('/api', apiRouter);

  return app;
}
