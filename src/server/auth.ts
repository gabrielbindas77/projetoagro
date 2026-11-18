import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { getUserProfileById } from './store-repo.ts';

export type UserRole = 'CLIENTE' | 'ADMIN';

export interface SessionUser {
  id: string;
  cpf: string;
  nome: string;
  email: string;
  papel: UserRole;
}

export interface AuthRequest extends Request {
  user?: SessionUser;
}

const COOKIE_NAME = 'agro_marconato_session';

function resolveJwtSecret(): string {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) {
    return process.env.JWT_SECRET;
  }
  const secretPath = path.resolve(process.cwd(), 'data', '.jwt_secret');
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }
  const generated = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  return generated;
}

const JWT_SECRET = resolveJwtSecret();

export function signSessionToken(user: SessionUser): string {
  return jwt.sign(
    {
      sub: user.id,
      cpf: user.cpf,
      nome: user.nome,
      email: user.email,
      papel: user.papel,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function verifySessionToken(token: string): SessionUser | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (!decoded?.sub || !decoded?.papel) return null;
    return {
      id: decoded.sub,
      cpf: decoded.cpf,
      nome: decoded.nome,
      email: decoded.email,
      papel: decoded.papel,
    };
  } catch {
    return null;
  }
}

function isHttpsRequest(req: Request): boolean {
  const xfProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  const appUrl = String(process.env.APP_URL || '').toLowerCase();
  return req.secure || xfProto.includes('https') || appUrl.startsWith('https://');
}

export function setSessionCookie(req: Request, res: Response, token: string) {
  const https = isHttpsRequest(req);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: https ? 'none' : 'lax',
    secure: https,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(req: Request, res: Response) {
  const https = isHttpsRequest(req);
  res.clearCookie(COOKIE_NAME, {
    path: '/',
    sameSite: https ? 'none' : 'lax',
    secure: https,
  });
}

export function extractTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (cookieToken) return cookieToken;
  return null;
}

export function extractTokenFromCookieHeader(cookieHeader?: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    if (key === COOKIE_NAME) return val;
  }
  return null;
}

export function extractTokenFromWsRequest(req: { url?: string; headers: { cookie?: string } }): string | null {
  if (req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const qp = parsed.searchParams.get('token');
      if (qp) return qp.trim();
    } catch {
      // ignore malformed URL
    }
  }
  return extractTokenFromCookieHeader(req.headers.cookie);
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = extractTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: 'Autenticação obrigatória. Faça login para continuar.' });
  }
  const user = verifySessionToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
  }
  req.user = user;
  next();
}

export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const token = extractTokenFromRequest(req);
  if (token) {
    const user = verifySessionToken(token);
    if (user) req.user = user;
  }
  next();
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, async () => {
    if (req.user?.papel !== 'ADMIN') {
      return res.status(403).json({ error: 'Acesso restrito a administradores.' });
    }
    try {
      const adminRow = await getUserProfileById(req.user.id, 'ADMIN');
      if (!adminRow) {
        return res.status(403).json({ error: 'Conta administrativa inativa ou não encontrada.' });
      }
      next();
    } catch {
      return res.status(500).json({ error: 'Erro ao validar permissão administrativa.' });
    }
  });
}

export function requireCliente(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.user?.papel !== 'CLIENTE') {
      return res.status(403).json({ error: 'Esta operação é exclusiva para contas de clientes.' });
    }
    next();
  });
}
