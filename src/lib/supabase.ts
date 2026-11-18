import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const env = (import.meta as any).env || {};

function cleanEnvValue(raw?: string): string {
  if (!raw) return '';
  let val = String(raw).trim();
  while (
    val.length >= 2 &&
    ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
  ) {
    val = val.slice(1, -1).trim();
  }
  if (!val) return '';
  const lower = val.toLowerCase();
  if (
    lower.startsWith('my_') ||
    lower.startsWith('your-') ||
    lower.startsWith('your_') ||
    lower.includes('placeholder') ||
    (val.startsWith('<') && val.endsWith('>'))
  ) {
    return '';
  }
  return val;
}

function extractProjectRef(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('.supabase.co')) {
      return host.split('.')[0] || '';
    }
  } catch {
    // ignore
  }
  return '';
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = atob(b64 + pad);
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function isValidBrowserPublicKey(key: string, projectRef: string): boolean {
  if (!key) return false;
  if (key.startsWith('sb_secret_')) return false;
  if (key.startsWith('sb_publishable_')) return key.length > 20;
  const jwt = decodeJwtPayload(key);
  if (jwt) {
    if (jwt.role === 'service_role') return false;
    if (projectRef && jwt.ref && String(jwt.ref) !== projectRef) return false;
    return true;
  }
  return key.length >= 20;
}

const SUPABASE_URL: string = (
  cleanEnvValue(env.VITE_SUPABASE_URL) || cleanEnvValue(env.NEXT_PUBLIC_SUPABASE_URL)
).replace(/\/+$/, '');

const PROJECT_REF = extractProjectRef(SUPABASE_URL);

const SUPABASE_ANON_KEY: string =
  [
    cleanEnvValue(env.VITE_SUPABASE_PUBLISHABLE_KEY),
    cleanEnvValue(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
    cleanEnvValue(env.VITE_SUPABASE_ANON_KEY),
    cleanEnvValue(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  ].find((cand) => isValidBrowserPublicKey(cand, PROJECT_REF)) || '';

let browserClient: SupabaseClient | null = null;

export function isFrontendSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_URL.startsWith('https://'));
}

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (!isFrontendSupabaseConfigured()) return null;
  if (!browserClient) {
    browserClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  }
  return browserClient;
}

export function cpfToInternalEmail(rawCpf: string): string {
  const cpfLimpo = String(rawCpf || '').replace(/\D/g, '');
  return `${cpfLimpo}@agromarconato.local`;
}
