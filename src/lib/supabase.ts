import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const env = (import.meta as any).env || {};

const SUPABASE_URL: string =
  env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '';

const SUPABASE_ANON_KEY: string =
  env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  env.VITE_SUPABASE_ANON_KEY ||
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  '';

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
