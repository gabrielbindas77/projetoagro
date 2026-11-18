import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cleanDigits } from './utils.ts';

let cachedClient: SupabaseClient | null = null;
let bootstrappedAdmin = false;

export const ADMIN_MASTER_CPF = cleanDigits(process.env.ADMIN_BOOTSTRAP_CPF || '11241313962');
export const ADMIN_MASTER_PASSWORD = process.env.ADMIN_BOOTSTRAP_SENHA || '03122911#';

export function resolveSupabaseUrl(): string {
  return (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    ''
  ).trim();
}

export function resolveSupabaseServiceKey(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    ''
  ).trim();
}

export function resolveSupabasePublicKey(): string {
  return (
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ''
  ).trim();
}

export function cpfToAuthEmail(cpf: string): string {
  return `${cleanDigits(cpf)}@agromarconato.local`;
}

export function isSupabaseConfigured(): boolean {
  const url = resolveSupabaseUrl();
  const key = resolveSupabaseServiceKey();
  return Boolean(url && key && url.startsWith('https://'));
}

export function getSupabaseAdmin(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (!cachedClient) {
    cachedClient = createClient(resolveSupabaseUrl(), resolveSupabaseServiceKey(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return cachedClient;
}

export function createEphemeralSupabaseClient(): SupabaseClient | null {
  const url = resolveSupabaseUrl();
  const key = resolveSupabasePublicKey() || resolveSupabaseServiceKey();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function ensureSupabaseAdminBootstrap() {
  if (bootstrappedAdmin) return;
  const sb = getSupabaseAdmin();
  if (!sb) return;

  try {
    // Check if schema tables exist
    const { error: checkErr } = await sb
      .from('profiles')
      .select('id', { count: 'exact', head: true });

    if (checkErr) {
      console.warn('[SUPABASE] Aguardando execução do supabase/schema.sql:', checkErr.message);
      return;
    }

    const adminEmail = cpfToAuthEmail(ADMIN_MASTER_CPF);
    const adminName = process.env.ADMIN_BOOTSTRAP_NOME || 'Administrador Agro Marconato';

    const { data: existingProfile } = await sb
      .from('profiles')
      .select('id, is_admin')
      .eq('cpf', ADMIN_MASTER_CPF)
      .maybeSingle();

    if (!existingProfile) {
      // Check if auth user already exists or create it
      const { data: createdAuth, error: createErr } = await sb.auth.admin.createUser({
        email: adminEmail,
        password: ADMIN_MASTER_PASSWORD,
        email_confirm: true,
        user_metadata: {
          cpf: ADMIN_MASTER_CPF,
          full_name: adminName,
        },
      });

      if (createdAuth?.user) {
        await sb.from('profiles').upsert(
          {
            id: createdAuth.user.id,
            cpf: ADMIN_MASTER_CPF,
            full_name: adminName,
            email: adminEmail,
            is_admin: true,
          },
          { onConflict: 'id' }
        );
        console.info(`[SUPABASE] Administrador principal inicializado — CPF: ${ADMIN_MASTER_CPF}`);
      } else if (createErr && createErr.message.toLowerCase().includes('already')) {
        const { data: listData } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
        const matched = listData?.users?.find((u) => u.email?.toLowerCase() === adminEmail);
        if (matched) {
          await sb.from('profiles').upsert(
            {
              id: matched.id,
              cpf: ADMIN_MASTER_CPF,
              full_name: adminName,
              email: adminEmail,
              is_admin: true,
            },
            { onConflict: 'id' }
          );
        }
      }
    } else if (!existingProfile.is_admin) {
      await sb.from('profiles').update({ is_admin: true }).eq('id', existingProfile.id);
    }

    bootstrappedAdmin = true;
  } catch (err: any) {
    console.warn('[SUPABASE] Erro ao inicializar admin bootstrap:', err?.message);
  }
}
