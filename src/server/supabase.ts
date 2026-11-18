import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cleanDigits } from './utils.ts';

let cachedClient: SupabaseClient | null = null;
let cachedClientKey = '';
let activeServiceKeyIndex = 0;
let bootstrappedAdmin = false;

function cleanEnvValue(raw?: string): string {
  if (!raw) return '';
  let val = String(raw).trim();
  // Strip wrapping quotes if copied with "..." or '...' into Vercel/env UI
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

function extractProjectRefFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('.supabase.co')) {
      return host.split('.')[0] || '';
    }
  } catch {
    // ignore invalid URL
  }
  return '';
}

function decodeJwtPayloadSafe(token: string): Record<string, any> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function isValidServiceKeyCandidate(key: string, projectRef: string): boolean {
  if (!key) return false;
  if (key.startsWith('sb_publishable_')) return false;
  if (key.startsWith('sb_secret_')) return key.length > 20;
  const jwt = decodeJwtPayloadSafe(key);
  if (jwt) {
    if (jwt.role && jwt.role !== 'service_role') return false;
    if (projectRef && jwt.ref && String(jwt.ref) !== projectRef) return false;
    return true;
  }
  return key.length >= 20;
}

function isValidPublicKeyCandidate(key: string, projectRef: string): boolean {
  if (!key) return false;
  if (key.startsWith('sb_secret_')) return false;
  if (key.startsWith('sb_publishable_')) return key.length > 20;
  const jwt = decodeJwtPayloadSafe(key);
  if (jwt) {
    if (jwt.role === 'service_role') return false;
    if (projectRef && jwt.ref && String(jwt.ref) !== projectRef) return false;
    return true;
  }
  return key.length >= 20;
}

export const ADMIN_MASTER_CPF = cleanDigits(cleanEnvValue(process.env.ADMIN_BOOTSTRAP_CPF) || '11241313962');
export const ADMIN_MASTER_PASSWORD = cleanEnvValue(process.env.ADMIN_BOOTSTRAP_SENHA) || '03122911#';

export function resolveSupabaseUrl(): string {
  const raw =
    cleanEnvValue(process.env.SUPABASE_URL) ||
    cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_URL) ||
    cleanEnvValue(process.env.VITE_SUPABASE_URL) ||
    '';
  return raw.replace(/\/+$/, '');
}

export function resolveServiceKeyCandidates(): string[] {
  const projectRef = extractProjectRefFromUrl(resolveSupabaseUrl());
  const rawCandidates = [
    cleanEnvValue(process.env.SUPABASE_SECRET_KEY),
    cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY),
  ];
  const unique: string[] = [];
  for (const cand of rawCandidates) {
    if (cand && isValidServiceKeyCandidate(cand, projectRef) && !unique.includes(cand)) {
      unique.push(cand);
    }
  }
  return unique;
}

export function resolvePublicKeyCandidates(): string[] {
  const projectRef = extractProjectRefFromUrl(resolveSupabaseUrl());
  const rawCandidates = [
    cleanEnvValue(process.env.SUPABASE_PUBLISHABLE_KEY),
    cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
    cleanEnvValue(process.env.VITE_SUPABASE_PUBLISHABLE_KEY),
    cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    cleanEnvValue(process.env.VITE_SUPABASE_ANON_KEY),
  ];
  const unique: string[] = [];
  for (const cand of rawCandidates) {
    if (cand && isValidPublicKeyCandidate(cand, projectRef) && !unique.includes(cand)) {
      unique.push(cand);
    }
  }
  return unique;
}

export function resolveSupabaseServiceKey(): string {
  const candidates = resolveServiceKeyCandidates();
  if (candidates.length === 0) return '';
  return candidates[activeServiceKeyIndex] || candidates[0];
}

export function resolveSupabasePublicKey(): string {
  const candidates = resolvePublicKeyCandidates();
  return candidates[0] || '';
}

export function isInvalidApiKeyMessage(msg?: string | null): boolean {
  if (!msg) return false;
  const lower = String(msg).toLowerCase();
  return (
    lower.includes('invalid api key') ||
    lower.includes('invalid jwt') ||
    lower.includes('no api key found')
  );
}

export function rotateSupabaseServiceKey(): boolean {
  const candidates = resolveServiceKeyCandidates();
  if (activeServiceKeyIndex + 1 < candidates.length) {
    activeServiceKeyIndex += 1;
    cachedClient = null;
    cachedClientKey = '';
    return true;
  }
  return false;
}

export function resetSupabaseAdminClientCache() {
  cachedClient = null;
  cachedClientKey = '';
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
  const url = resolveSupabaseUrl();
  const key = resolveSupabaseServiceKey();
  if (!cachedClient || cachedClientKey !== `${url}::${key}`) {
    cachedClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    cachedClientKey = `${url}::${key}`;
  }
  return cachedClient;
}

export function createEphemeralSupabaseClient(explicitKey?: string): SupabaseClient | null {
  const url = resolveSupabaseUrl();
  const key = explicitKey || resolveSupabasePublicKey() || resolveSupabaseServiceKey();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function signInSupabasePasswordWithFallback(email: string, password: string) {
  const keysToTry: string[] = [];
  for (const k of [...resolvePublicKeyCandidates(), ...resolveServiceKeyCandidates()]) {
    if (k && !keysToTry.includes(k)) keysToTry.push(k);
  }
  if (keysToTry.length === 0) {
    return { data: { user: null, session: null }, error: new Error('Supabase não configurado.') };
  }

  let lastResult: any = null;
  for (const key of keysToTry) {
    const client = createEphemeralSupabaseClient(key);
    if (!client) continue;
    const result = await client.auth.signInWithPassword({ email, password });
    lastResult = result;
    if (!result.error || !isInvalidApiKeyMessage(result.error.message)) {
      return result;
    }
  }
  return lastResult;
}

export async function ensureSupabaseAdminBootstrap() {
  if (bootstrappedAdmin) return;
  let sb = getSupabaseAdmin();
  if (!sb) return;

  try {
    let checkRes = await sb.from('profiles').select('id', { count: 'exact', head: true });

    while (checkRes.error && isInvalidApiKeyMessage(checkRes.error.message) && rotateSupabaseServiceKey()) {
      sb = getSupabaseAdmin();
      if (!sb) return;
      checkRes = await sb.from('profiles').select('id', { count: 'exact', head: true });
    }

    if (checkRes.error) {
      if (isInvalidApiKeyMessage(checkRes.error.message)) {
        console.warn('[SUPABASE] Chave de API inválida detectada. Verifique SUPABASE_URL e SUPABASE_SECRET_KEY.');
      } else {
        console.warn('[SUPABASE] Aguardando execução do supabase/schema.sql:', checkRes.error.message);
      }
      return;
    }

    const adminEmail = cpfToAuthEmail(ADMIN_MASTER_CPF);
    const adminName = cleanEnvValue(process.env.ADMIN_BOOTSTRAP_NOME) || 'Administrador Agro Marconato';

    const { data: existingProfile } = await sb
      .from('profiles')
      .select('id, is_admin')
      .eq('cpf', ADMIN_MASTER_CPF)
      .maybeSingle();

    if (!existingProfile) {
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
