import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { cleanDigits } from './utils.ts';

let cachedClient: SupabaseClient | null = null;
let bootstrappedAdmin = false;

export function isSupabaseConfigured(): boolean {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(url && key && url.startsWith('https://'));
}

export function getSupabaseAdmin(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (!cachedClient) {
    const url = process.env.SUPABASE_URL!;
    const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)!;
    cachedClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return cachedClient;
}

export async function ensureSupabaseAdminBootstrap() {
  if (bootstrappedAdmin) return;
  const sb = getSupabaseAdmin();
  if (!sb) return;

  try {
    const { count, error } = await sb
      .from('administradores')
      .select('id', { count: 'exact', head: true });

    if (error) {
      console.warn('[SUPABASE] Aguardando execução do schema.sql:', error.message);
      return;
    }

    if ((count || 0) === 0) {
      const bootCpf = cleanDigits(process.env.ADMIN_BOOTSTRAP_CPF || '52998224725');
      const bootPass = process.env.ADMIN_BOOTSTRAP_SENHA || 'Agro@2026!Admin';
      const bootName = process.env.ADMIN_BOOTSTRAP_NOME || 'Administrador Agro Marconato';
      const bootEmail = process.env.ADMIN_BOOTSTRAP_EMAIL || 'admin@agromarconato.com.br';
      const bootPhone = cleanDigits(process.env.ADMIN_BOOTSTRAP_TELEFONE || '11999990000');
      const hash = bcrypt.hashSync(bootPass, 10);

      const { error: insErr } = await sb.from('administradores').insert({
        nome_completo: bootName,
        cpf: bootCpf,
        email: bootEmail,
        telefone: bootPhone,
        senha_hash: hash,
        papel: 'ADMIN',
        ativo: true,
      });

      if (!insErr) {
        console.info(`[SUPABASE] Administrador inicial criado — CPF: ${bootCpf}`);
      }
    }
    bootstrappedAdmin = true;
  } catch (err: any) {
    console.warn('[SUPABASE] Erro ao inicializar bootstrap:', err?.message);
  }
}
