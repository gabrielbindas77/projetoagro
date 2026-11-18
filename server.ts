import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { initDatabase } from './src/server/db.ts';
import { apiRouter } from './src/server/routes.ts';
import { ensureSupabaseAdminBootstrap, isSupabaseConfigured } from './src/server/supabase.ts';
import { setupWebSocketServer } from './src/server/ws.ts';

dotenv.config();

async function startServer() {
  initDatabase();
  if (isSupabaseConfigured()) {
    await ensureSupabaseAdminBootstrap();
    console.log('[DB] Conectado ao Supabase PostgreSQL + Storage.');
  } else {
    console.log('[DB] Modo local SQLite ativo (defina SUPABASE_URL e SUPABASE_SECRET_KEY para usar Supabase).');
  }

  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    '/uploads',
    express.static(path.resolve(process.cwd(), 'uploads'), {
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

  const server = http.createServer(app);
  setupWebSocketServer(server);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Agro Marconato Agropecuária rodando em http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Falha ao iniciar servidor Agro Marconato:', err);
  process.exit(1);
});
