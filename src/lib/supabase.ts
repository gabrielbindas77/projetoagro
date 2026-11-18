import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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

const procEnv = typeof process !== 'undefined' && process?.env ? process.env : undefined;

const SUPABASE_URL: string = (
  cleanEnvValue(import.meta.env.NEXT_PUBLIC_SUPABASE_URL) ||
  cleanEnvValue(import.meta.env.VITE_SUPABASE_URL) ||
  cleanEnvValue(procEnv?.NEXT_PUBLIC_SUPABASE_URL) ||
  cleanEnvValue(procEnv?.VITE_SUPABASE_URL)
).replace(/\/+$/, '');

const SUPABASE_PUBLIC_KEY: string =
  cleanEnvValue(import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) ||
  cleanEnvValue(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) ||
  cleanEnvValue(import.meta.env.VITE_SUPABASE_ANON_KEY) ||
  cleanEnvValue(import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ||
  cleanEnvValue(procEnv?.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) ||
  cleanEnvValue(procEnv?.VITE_SUPABASE_PUBLISHABLE_KEY) ||
  cleanEnvValue(procEnv?.VITE_SUPABASE_ANON_KEY) ||
  cleanEnvValue(procEnv?.NEXT_PUBLIC_SUPABASE_ANON_KEY) ||
  '';

let browserClient: SupabaseClient | null = null;

export function isFrontendSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_PUBLIC_KEY && SUPABASE_URL.startsWith('https://'));
}

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (!isFrontendSupabaseConfigured()) return null;
  if (!browserClient) {
    browserClient = createClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  }
  return browserClient;
}

export const supabase: SupabaseClient | null = getSupabaseBrowserClient();

export function cpfToInternalEmail(rawCpf: string): string {
  const cpfLimpo = String(rawCpf || '').replace(/\D/g, '');
  return `${cpfLimpo}@agromarconato.local`;
}
