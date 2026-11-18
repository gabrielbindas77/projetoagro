import express from 'express';
import http from 'http';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createExpressApp, ensureBackendInitialized } from './src/server/app.ts';
import { isSupabaseConfigured } from './src/server/supabase.ts';
import { setupWebSocketServer } from './src/server/ws.ts';

async function startServer() {
  await ensureBackendInitialized();
  if (isSupabaseConfigured()) {
    console.log('[DB] Conectado ao Supabase PostgreSQL + Storage.');
  } else {
    console.log('[DB] Modo local SQLite ativo (defina SUPABASE_URL e SUPABASE_SECRET_KEY para usar Supabase).');
  }

  const app = createExpressApp();
  const PORT = Number(process.env.PORT || 3000);

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
