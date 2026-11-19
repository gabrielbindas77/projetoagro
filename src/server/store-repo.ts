import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { db, getStoreConfig as getSqliteConfig, uploadsDir } from './db.ts';
import {
  ADMIN_MASTER_CPF,
  cpfToAuthEmail,
  ensureSupabaseAdminBootstrap,
  extractProjectRefFromUrl,
  getSupabaseAdmin,
  isInvalidApiKeyMessage,
  isSupabaseConfigured,
  resolveSupabaseUrl,
  rotateSupabaseServiceKey,
  signInSupabasePasswordWithFallback,
} from './supabase.ts';
import { cleanDigits, normalizeText } from './utils.ts';

function boolNum(val: any): number {
  return val === true || val === 1 ? 1 : 0;
}

function resolveUnitType(input: any): 'kg' | 'un' {
  if (input === 'kg' || input === 'PESO_KG' || input === 'KG' || input === 'PESO_E_VALOR' || input === 'VALOR_DINHEIRO') {
    return 'kg';
  }
  return 'un';
}

export async function getConfigMap(): Promise<Record<string, string>> {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: adm } = await sb
      .from('admin_settings')
      .select('pix_key, pix_key_type, pix_recipient_name, shipping_fee, whatsapp_loja, exibir_esgotados_catalogo')
      .eq('id', 1)
      .maybeSingle();

    return {
      frete_padrao_centavos: '499',
      max_parcelas: '1',
      parcelas_sem_juros: '1',
      taxa_juros_mensal: '0',
      exibir_esgotados_catalogo: adm?.exibir_esgotados_catalogo === false ? 'false' : 'true',
      whatsapp_loja: adm?.whatsapp_loja || process.env.STORE_WHATSAPP_NUMBER || '5511999999999',
      precisao_pesagem_padrao: '3',
      pix_key: adm?.pix_key || '',
      pix_key_type: adm?.pix_key_type || 'CPF',
      pix_recipient_name: adm?.pix_recipient_name || 'Agro Marconato Agropecuária',
    };
  }
  const sqliteCfg = getSqliteConfig();
  sqliteCfg.frete_padrao_centavos = '499';
  return sqliteCfg;
}

export async function updateConfigMap(entries: Record<string, string>) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const current = await getConfigMap();
    const { error } = await sb.from('admin_settings').upsert(
      {
        id: 1,
        pix_key: entries.pix_key !== undefined ? entries.pix_key : current.pix_key,
        pix_key_type: entries.pix_key_type !== undefined ? entries.pix_key_type : current.pix_key_type || 'CPF',
        pix_recipient_name:
          entries.pix_recipient_name !== undefined ? entries.pix_recipient_name : current.pix_recipient_name,
        shipping_fee: 4.99,
        whatsapp_loja: entries.whatsapp_loja !== undefined ? entries.whatsapp_loja : current.whatsapp_loja,
        exibir_esgotados_catalogo:
          entries.exibir_esgotados_catalogo !== undefined
            ? entries.exibir_esgotados_catalogo !== 'false'
            : current.exibir_esgotados_catalogo !== 'false',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );
    if (error) throw new Error(error.message);
    return getConfigMap();
  }

  const upsert = db.prepare(`
    INSERT INTO configuracoes_loja (chave, valor, atualizado_em)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = datetime('now')
  `);
  for (const [k, v] of Object.entries(entries)) {
    upsert.run(k, k === 'frete_padrao_centavos' ? '499' : String(v));
  }
  upsert.run('frete_padrao_centavos', '499');
  return getConfigMap();
}

// ==============================================================================
// AUTH & RATE LIMIT (Unified CPF + Password, strictly 1 registration per CPF)
// ==============================================================================

export async function checkRateLimit(key: string): Promise<{ allowed: boolean; minutesRemaining?: number }> {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data } = await sb.from('tentativas_login').select('*').eq('chave', key).maybeSingle();
    if (!data) return { allowed: true };
    if (data.bloqueado_ate) {
      const blocked = new Date(data.bloqueado_ate).getTime();
      if (blocked > Date.now()) {
        return { allowed: false, minutesRemaining: Math.ceil((blocked - Date.now()) / 60000) };
      }
      await sb.from('tentativas_login').delete().eq('chave', key);
    }
    return { allowed: true };
  }

  const row = db
    .prepare(`SELECT tentativas, bloqueado_ate FROM tentativas_login WHERE chave = ?`)
    .get(key) as { tentativas: number; bloqueado_ate: string | null } | undefined;
  if (!row) return { allowed: true };
  if (row.bloqueado_ate) {
    const blockedUntil = new Date(row.bloqueado_ate).getTime();
    if (blockedUntil > Date.now()) {
      return { allowed: false, minutesRemaining: Math.ceil((blockedUntil - Date.now()) / 60000) };
    }
    db.prepare(`DELETE FROM tentativas_login WHERE chave = ?`).run(key);
  }
  return { allowed: true };
}

export async function recordFailedAttempt(key: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data } = await sb.from('tentativas_login').select('tentativas').eq('chave', key).maybeSingle();
    const attempts = (data?.tentativas || 0) + 1;
    const blockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    await sb.from('tentativas_login').upsert(
      { chave: key, tentativas: attempts, bloqueado_ate: blockedUntil, atualizado_em: new Date().toISOString() },
      { onConflict: 'chave' }
    );
    return;
  }

  const row = db.prepare(`SELECT tentativas FROM tentativas_login WHERE chave = ?`).get(key) as
    | { tentativas: number }
    | undefined;
  const attempts = (row?.tentativas || 0) + 1;
  const blockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
  db.prepare(`
    INSERT INTO tentativas_login (chave, tentativas, bloqueado_ate, atualizado_em)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(chave) DO UPDATE SET tentativas = excluded.tentativas, bloqueado_ate = excluded.bloqueado_ate, atualizado_em = datetime('now')
  `).run(key, attempts, blockedUntil);
}

export async function clearFailedAttempts(key: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    await sb.from('tentativas_login').delete().eq('chave', key);
    return;
  }
  db.prepare(`DELETE FROM tentativas_login WHERE chave = ?`).run(key);
}

export async function findUserByCpfOrEmail(cpf: string, email: string) {
  const clean = cleanDigits(cpf);
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: prof } = await sb.from('profiles').select('id').eq('cpf', clean).maybeSingle();
    return {
      cpfExists: Boolean(prof),
      emailExists: false,
    };
  }
  const existingCpf = db
    .prepare(`SELECT id FROM clientes WHERE cpf = ? UNION SELECT id FROM administradores WHERE cpf = ?`)
    .get(clean, clean);
  const existingEmail = email
    ? db
        .prepare(`SELECT id FROM clientes WHERE email = ? UNION SELECT id FROM administradores WHERE email = ?`)
        .get(email, email)
    : null;
  return { cpfExists: Boolean(existingCpf), emailExists: Boolean(existingEmail) };
}

export async function registerUserByCpfPassword(input: {
  cpf: string;
  senha: string;
  nome_completo?: string;
  telefone?: string;
}) {
  const cpf = cleanDigits(input.cpf);
  const authEmail = cpfToAuthEmail(cpf);
  const fullName = String(input.nome_completo || '').trim() || `Cliente ${cpf.slice(-4)}`;
  const phone = cleanDigits(input.telefone || '');
  const isAdmin = cpf === ADMIN_MASTER_CPF;

  let sb = getSupabaseAdmin();
  if (sb) {
    await ensureSupabaseAdminBootstrap();

    const runWithKeyRotation = async <T extends { error: any; data?: any }>(
      fn: (client: NonNullable<typeof sb>) => PromiseLike<T>
    ): Promise<T> => {
      let current = getSupabaseAdmin()!;
      let res = await fn(current);
      while (res.error && isInvalidApiKeyMessage(res.error.message) && rotateSupabaseServiceKey()) {
        current = getSupabaseAdmin()!;
        res = await fn(current);
      }
      return res;
    };

    const existingRes = await runWithKeyRotation(async (client) =>
      client.from('profiles').select('id').eq('cpf', cpf).maybeSingle()
    );
    if (existingRes.error) {
      if (isInvalidApiKeyMessage(existingRes.error.message)) {
        throw new Error(
          'Chave de API do Supabase inválida. Verifique nas variáveis de ambiente se SUPABASE_URL, SUPABASE_SECRET_KEY (sb_secret_...) e SUPABASE_SERVICE_ROLE_KEY estão corretas, sem aspas e do mesmo projeto.'
        );
      }
      throw new Error(existingRes.error.message);
    }
    if (existingRes.data) {
      throw new Error('Este CPF já está cadastrado no sistema.');
    }

    const createdRes = await runWithKeyRotation((client) =>
      client.auth.admin.createUser({
        email: authEmail,
        password: input.senha,
        email_confirm: true,
        user_metadata: {
          cpf,
          full_name: fullName,
          phone,
        },
      })
    );

    if (createdRes.error) {
      const msg = createdRes.error.message || '';
      if (isInvalidApiKeyMessage(msg)) {
        throw new Error(
          'Chave de API do Supabase inválida. Verifique nas variáveis de ambiente se SUPABASE_URL e SUPABASE_SECRET_KEY (sb_secret_...) estão corretas e sem aspas.'
        );
      }
      if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('registered')) {
        throw new Error('Este CPF já está cadastrado no sistema.');
      }
      throw new Error(msg);
    }

    const userId = createdRes.data.user.id;
    sb = getSupabaseAdmin()!;
    await sb.from('profiles').delete().eq('cpf', cpf).neq('id', userId);
    const { data: profile, error: profErr } = await sb
      .from('profiles')
      .upsert(
        {
          id: userId,
          cpf,
          full_name: fullName,
          phone,
          email: authEmail,
          is_admin: isAdmin,
        },
        { onConflict: 'id' }
      )
      .select('*')
      .single();

    if (profErr) throw new Error(profErr.message);

    return {
      id: profile.id,
      nome_completo: profile.full_name || fullName,
      cpf: profile.cpf,
      email: profile.email || authEmail,
      telefone: profile.phone || phone,
      is_admin: Boolean(profile.is_admin),
      papel: profile.is_admin ? ('ADMIN' as const) : ('CLIENTE' as const),
    };
  }

  // Local SQLite fallback
  const dup = await findUserByCpfOrEmail(cpf, authEmail);
  if (dup.cpfExists) {
    throw new Error('Este CPF já está cadastrado no sistema.');
  }

  const hash = bcrypt.hashSync(input.senha, 10);
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO clientes (id, nome_completo, cpf, email, telefone, senha_hash, email_verificado, telefone_verificado, identidade_verificada, papel)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, 'CLIENTE')
  `).run(id, fullName, cpf, authEmail, phone, hash);

  return {
    id,
    nome_completo: fullName,
    cpf,
    email: authEmail,
    telefone: phone,
    is_admin: false,
    papel: 'CLIENTE' as const,
  };
}

export async function authenticateUserByCpfPassword(cpfRaw: string, senha: string) {
  const cpf = cleanDigits(cpfRaw);
  const authEmail = cpfToAuthEmail(cpf);
  let sb = getSupabaseAdmin();

  if (sb) {
    await ensureSupabaseAdminBootstrap();
    const { data: signInData, error: signInErr } = await signInSupabasePasswordWithFallback(authEmail, senha);

    if (signInErr || !signInData?.user) {
      return null;
    }

    const userId = signInData.user.id;
    sb = getSupabaseAdmin()!;
    let profRes = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (profRes.error && isInvalidApiKeyMessage(profRes.error.message) && rotateSupabaseServiceKey()) {
      sb = getSupabaseAdmin()!;
      profRes = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    }
    let profile = profRes.data;

    if (!profile) {
      const isAdmin = cpf === ADMIN_MASTER_CPF;
      await sb.from('profiles').delete().eq('cpf', cpf).neq('id', userId);
      const { data: inserted } = await sb
        .from('profiles')
        .upsert(
          {
            id: userId,
            cpf,
            full_name: isAdmin ? 'Administrador Agro Marconato' : `Cliente ${cpf.slice(-4)}`,
            email: authEmail,
            is_admin: isAdmin,
          },
          { onConflict: 'id' }
        )
        .select('*')
        .single();
      profile = inserted;
    }

    const isAdmin = Boolean(profile?.is_admin || cpf === ADMIN_MASTER_CPF);
    return {
      id: userId,
      nome_completo: profile?.full_name || (isAdmin ? 'Administrador Agro Marconato' : `Cliente ${cpf.slice(-4)}`),
      cpf,
      email: profile?.email || authEmail,
      telefone: profile?.phone || '',
      is_admin: isAdmin,
      papel: isAdmin ? ('ADMIN' as const) : ('CLIENTE' as const),
    };
  }

  // Local SQLite fallback
  const admin = db.prepare(`SELECT * FROM administradores WHERE cpf = ? AND ativo = 1`).get(cpf) as any;
  if (admin && bcrypt.compareSync(senha, admin.senha_hash)) {
    return {
      id: admin.id,
      nome_completo: admin.nome_completo,
      cpf: admin.cpf,
      email: admin.email,
      telefone: admin.telefone || '',
      is_admin: true,
      papel: 'ADMIN' as const,
    };
  }

  const cliente = db.prepare(`SELECT * FROM clientes WHERE cpf = ?`).get(cpf) as any;
  if (cliente && bcrypt.compareSync(senha, cliente.senha_hash)) {
    const isAdmin = cpf === ADMIN_MASTER_CPF;
    return {
      id: cliente.id,
      nome_completo: cliente.nome_completo,
      cpf: cliente.cpf,
      email: cliente.email,
      telefone: cliente.telefone || '',
      is_admin: isAdmin,
      papel: isAdmin ? ('ADMIN' as const) : ('CLIENTE' as const),
    };
  }

  return null;
}

export async function findAuthAccountByCpf(cpf: string): Promise<{ account: any; papel: 'ADMIN' | 'CLIENTE' } | null> {
  const clean = cleanDigits(cpf);
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: profile } = await sb.from('profiles').select('*').eq('cpf', clean).maybeSingle();
    if (!profile) return null;
    const isAdmin = Boolean(profile.is_admin || clean === ADMIN_MASTER_CPF);
    return {
      account: {
        id: profile.id,
        nome_completo: profile.full_name,
        cpf: profile.cpf,
        email: profile.email,
        telefone: profile.phone,
        is_admin: isAdmin,
      },
      papel: isAdmin ? 'ADMIN' : 'CLIENTE',
    };
  }

  const admin = db.prepare(`SELECT * FROM administradores WHERE cpf = ? AND ativo = 1`).get(clean) as any;
  if (admin) return { account: { ...admin, is_admin: true }, papel: 'ADMIN' };
  const cliente = db.prepare(`SELECT * FROM clientes WHERE cpf = ?`).get(clean) as any;
  if (cliente) return { account: { ...cliente, is_admin: clean === ADMIN_MASTER_CPF }, papel: clean === ADMIN_MASTER_CPF ? 'ADMIN' : 'CLIENTE' };
  return null;
}

export async function getUserProfileById(id: string, papel: 'ADMIN' | 'CLIENTE') {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: profile } = await sb.from('profiles').select('*').eq('id', id).maybeSingle();
    if (!profile) return null;
    const isAdmin = Boolean(profile.is_admin || profile.cpf === ADMIN_MASTER_CPF);
    return {
      id: profile.id,
      nome_completo: profile.full_name || `Cliente ${String(profile.cpf).slice(-4)}`,
      cpf: profile.cpf,
      email: profile.email || cpfToAuthEmail(profile.cpf),
      telefone: profile.phone || '',
      is_admin: isAdmin,
      papel: isAdmin ? ('ADMIN' as const) : ('CLIENTE' as const),
      email_verificado: true,
      telefone_verificado: true,
      identidade_verificada: true,
    };
  }

  if (papel === 'ADMIN') {
    const adm = db
      .prepare(`SELECT id, nome_completo, cpf, email, telefone, papel FROM administradores WHERE id = ? AND ativo = 1`)
      .get(id) as any;
    if (!adm) return null;
    return { ...adm, is_admin: true, papel: 'ADMIN' as const };
  }
  const cliente = db
    .prepare(
      `SELECT id, nome_completo, cpf, email, telefone, papel, email_verificado, telefone_verificado, identidade_verificada FROM clientes WHERE id = ?`
    )
    .get(id) as any;
  if (!cliente) return null;
  const isAdmin = cliente.cpf === ADMIN_MASTER_CPF;
  return {
    ...cliente,
    is_admin: isAdmin,
    papel: isAdmin ? ('ADMIN' as const) : ('CLIENTE' as const),
    email_verificado: true,
    telefone_verificado: true,
    identidade_verificada: true,
  };
}

export async function updateProfileContactInfo(
  userId: string,
  info: { full_name?: string; phone?: string }
) {
  const name = info.full_name ? String(info.full_name).trim() : undefined;
  const phone = info.phone ? cleanDigits(info.phone) : undefined;
  if (!name && !phone) return;

  const sb = getSupabaseAdmin();
  if (sb) {
    const patch: any = { updated_at: new Date().toISOString() };
    if (name) patch.full_name = name;
    if (phone) patch.phone = phone;
    await sb.from('profiles').update(patch).eq('id', userId);
    return;
  }

  if (name) {
    db.prepare(`UPDATE clientes SET nome_completo = ?, atualizado_em = datetime('now') WHERE id = ?`).run(name, userId);
  }
  if (phone) {
    db.prepare(`UPDATE clientes SET telefone = ?, atualizado_em = datetime('now') WHERE id = ?`).run(phone, userId);
  }
}

// ==============================================================================
// CATEGORIES & PRODUCTS + REAL IMAGE STORAGE
// ==============================================================================

export async function listCategorias() {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from('categorias')
      .select('*')
      .order('ordem', { ascending: true })
      .order('nome', { ascending: true });
    if (error) throw new Error(error.message);
    return data || [];
  }
  return db.prepare(`SELECT * FROM categorias ORDER BY ordem ASC, nome ASC`).all();
}

export async function createCategoria(nome: string, descricao: string) {
  const slug = normalizeText(nome).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = `cat-${slug}-${crypto.randomBytes(2).toString('hex')}`;
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb.from('categorias').insert({ id, nome, slug, descricao }).select('*').single();
    if (error) throw new Error('Categoria já cadastrada.');
    return data;
  }
  db.prepare(`INSERT INTO categorias (id, nome, slug, descricao) VALUES (?, ?, ?, ?)`).run(id, nome, slug, descricao);
  return { id, nome, slug, descricao };
}

function getEffectivePriceCentavos(produto: any): number {
  if (
    boolNum(produto.oferta) === 1 &&
    produto.preco_promocional_centavos !== null &&
    produto.preco_promocional_centavos !== undefined &&
    Number(produto.preco_promocional_centavos) > 0
  ) {
    return Number(produto.preco_promocional_centavos);
  }
  return Number(produto.preco_centavos);
}

function mapSupabaseProductRow(p: any) {
  const unitType: 'kg' | 'un' = p.unit_type === 'kg' ? 'kg' : 'un';
  const precoCentavos = Math.round(Number(p.price || 0) * 100);
  const promoCentavos = p.promo_price !== null && p.promo_price !== undefined ? Math.round(Number(p.promo_price) * 100) : null;
  const stock = Number(p.stock || 0);
  const situacao = !p.active ? 'INATIVO' : stock <= 0 ? 'ESGOTADO' : 'DISPONIVEL';
  const galleryRaw = Array.isArray(p.gallery_urls) ? p.gallery_urls : [];
  const urls: string[] = [];
  if (p.image_url) urls.push(p.image_url);
  for (const u of galleryRaw) {
    if (typeof u === 'string' && u && !urls.includes(u)) urls.push(u);
  }

  const imagens = urls.map((url, idx) => ({
    id: `${p.id}::img::${idx}`,
    produto_id: p.id,
    url,
    nome_arquivo: url.split('/').pop() || null,
    principal: idx === 0 ? 1 : 0,
    ordem: idx,
  }));

  const onSale = Boolean(p.on_sale);
  const effectiveCentavos =
    onSale && promoCentavos !== null && promoCentavos > 0 ? promoCentavos : precoCentavos;

  return {
    id: p.id,
    categoria_id: p.category_id || '',
    categoria_nome: p.categorias?.nome || 'Agropecuária',
    categoria_slug: p.categorias?.slug || '',
    nome: p.name,
    nome_normalizado: p.name_normalized || normalizeText(p.name || ''),
    descricao_completa: p.description || '',
    observacao_curta: p.short_description || '',
    palavras_chave: p.keywords || '',
    palavras_chave_normalizadas: p.keywords_normalized || normalizeText(p.keywords || ''),
    unit_type: unitType,
    preco_centavos: precoCentavos,
    preco_promocional_centavos: promoCentavos,
    preco_vigente_centavos: effectiveCentavos,
    estoque_quantidade: stock,
    estoque_baixo_limite: Number(p.low_stock_limit ?? 5),
    unidade_venda: unitType === 'kg' ? 'KG' : 'UN',
    modalidade_venda: unitType === 'kg' ? ('PESO_KG' as const) : ('UNIDADE' as const),
    precisao_pesagem: unitType === 'kg' ? 3 : 0,
    permite_parcelamento: 0,
    max_parcelas_produto: 1,
    situacao,
    destaque: p.featured ? 1 : 0,
    oferta: onSale ? 1 : 0,
    imagem_principal: urls[0] || null,
    imagens,
  };
}

function normalizeSqliteProductRow(p: any, catName?: string, catSlug?: string, imgs: any[] = []) {
  const primary = imgs.find((i) => boolNum(i.principal) === 1) || imgs[0] || null;
  const unitType = resolveUnitType(p.modalidade_venda);
  return {
    ...p,
    unit_type: unitType,
    unidade_venda: unitType === 'kg' ? 'KG' : 'UN',
    modalidade_venda: unitType === 'kg' ? 'PESO_KG' : 'UNIDADE',
    precisao_pesagem: unitType === 'kg' ? 3 : 0,
    preco_centavos: Number(p.preco_centavos),
    preco_promocional_centavos: p.preco_promocional_centavos !== null ? Number(p.preco_promocional_centavos) : null,
    estoque_quantidade: Number(p.estoque_quantidade),
    estoque_baixo_limite: Number(p.estoque_baixo_limite),
    permite_parcelamento: 0,
    max_parcelas_produto: 1,
    destaque: boolNum(p.destaque),
    oferta: boolNum(p.oferta),
    categoria_nome: catName ?? p.categoria_nome,
    categoria_slug: catSlug ?? p.categoria_slug,
    preco_vigente_centavos: getEffectivePriceCentavos(p),
    imagem_principal: primary ? primary.url : null,
    imagens: imgs.map((i) => ({ ...i, principal: boolNum(i.principal) })),
  };
}

export async function listProdutos(includeInactive = false) {
  const sb = getSupabaseAdmin();
  if (sb) {
    let q = sb
      .from('products')
      .select('*, categorias(nome, slug)')
      .order('featured', { ascending: false })
      .order('created_at', { ascending: false });
    if (!includeInactive) q = q.eq('active', true);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data || []).map(mapSupabaseProductRow);
  }

  const rows = db
    .prepare(`
      SELECT p.*, c.nome as categoria_nome, c.slug as categoria_slug
      FROM produtos p JOIN categorias c ON c.id = p.categoria_id
      ${includeInactive ? '' : "WHERE p.situacao != 'INATIVO'"}
      ORDER BY p.destaque DESC, p.criado_em DESC
    `)
    .all() as any[];

  const imgs = db.prepare(`SELECT * FROM imagens_produtos ORDER BY principal DESC, ordem ASC, criado_em ASC`).all() as any[];
  const byProd = new Map<string, any[]>();
  for (const img of imgs) {
    const arr = byProd.get(img.produto_id) || [];
    arr.push(img);
    byProd.set(img.produto_id, arr);
  }
  return rows.map((p) => normalizeSqliteProductRow(p, p.categoria_nome, p.categoria_slug, byProd.get(p.id) || []));
}

export async function getProdutoById(id: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: p } = await sb.from('products').select('*, categorias(nome, slug)').eq('id', id).maybeSingle();
    if (!p) return null;
    return mapSupabaseProductRow(p);
  }
  const row = db
    .prepare(`
      SELECT p.*, c.nome as categoria_nome, c.slug as categoria_slug
      FROM produtos p JOIN categorias c ON c.id = p.categoria_id WHERE p.id = ?
    `)
    .get(id) as any;
  if (!row) return null;
  const imgs = db.prepare(`SELECT * FROM imagens_produtos WHERE produto_id = ? ORDER BY principal DESC, ordem ASC`).all(id) as any[];
  return normalizeSqliteProductRow(row, row.categoria_nome, row.categoria_slug, imgs);
}

export async function createProduto(input: any) {
  const stock = Math.max(0, Number(input.estoque_quantidade || 0));
  const unitType = resolveUnitType(input.unit_type || input.modalidade_venda);
  const active = input.situacao !== 'INATIVO' && input.active !== false;
  const sb = getSupabaseAdmin();

  if (sb) {
    const price = Number((Math.round(Number(input.preco_centavos)) / 100).toFixed(2));
    const promoPrice = input.preco_promocional_centavos
      ? Number((Math.round(Number(input.preco_promocional_centavos)) / 100).toFixed(2))
      : null;

    const { data, error } = await sb
      .from('products')
      .insert({
        category_id: input.categoria_id || null,
        name: String(input.nome).trim(),
        name_normalized: normalizeText(String(input.nome)),
        short_description: String(input.observacao_curta || '').trim(),
        description: String(input.descricao_completa || '').trim(),
        keywords: String(input.palavras_chave || ''),
        keywords_normalized: normalizeText(String(input.palavras_chave || '')),
        unit_type: unitType,
        price,
        promo_price: promoPrice,
        stock,
        low_stock_limit: Number(input.estoque_baixo_limite ?? 5),
        active,
        featured: Boolean(input.destaque),
        on_sale: Boolean(input.oferta),
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return getProdutoById(data.id);
  }

  const computedSituacao = !active ? 'INATIVO' : stock <= 0 ? 'ESGOTADO' : 'DISPONIVEL';
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO produtos (
      id, categoria_id, nome, nome_normalizado, descricao_completa, observacao_curta,
      palavras_chave, palavras_chave_normalizadas, preco_centavos, preco_promocional_centavos,
      estoque_quantidade, estoque_baixo_limite, unidade_venda, modalidade_venda,
      precisao_pesagem, permite_parcelamento, max_parcelas_produto, situacao, destaque, oferta
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)
  `).run(
    id,
    input.categoria_id,
    String(input.nome).trim(),
    normalizeText(String(input.nome)),
    String(input.descricao_completa).trim(),
    String(input.observacao_curta).trim(),
    String(input.palavras_chave || ''),
    normalizeText(String(input.palavras_chave || '')),
    Math.round(Number(input.preco_centavos)),
    input.preco_promocional_centavos ? Math.round(Number(input.preco_promocional_centavos)) : null,
    stock,
    Number(input.estoque_baixo_limite ?? 5),
    unitType === 'kg' ? 'KG' : 'UN',
    unitType === 'kg' ? 'PESO_KG' : 'UNIDADE',
    unitType === 'kg' ? 3 : 0,
    computedSituacao,
    input.destaque ? 1 : 0,
    input.oferta ? 1 : 0
  );
  return getProdutoById(id);
}

export async function updateProduto(id: string, b: any) {
  const existing = await getProdutoById(id);
  if (!existing) return null;

  const nome = b.nome !== undefined ? String(b.nome).trim() : existing.nome;
  const palavras = b.palavras_chave !== undefined ? String(b.palavras_chave) : existing.palavras_chave;
  const stock = b.estoque_quantidade !== undefined ? Math.max(0, Number(b.estoque_quantidade)) : existing.estoque_quantidade;
  const unitType = resolveUnitType(b.unit_type ?? b.modalidade_venda ?? existing.unit_type);
  const active = b.active !== undefined ? Boolean(b.active) : b.situacao !== undefined ? b.situacao !== 'INATIVO' : existing.situacao !== 'INATIVO';

  const sb = getSupabaseAdmin();
  if (sb) {
    const precoCent = b.preco_centavos !== undefined ? Math.round(Number(b.preco_centavos)) : existing.preco_centavos;
    const promoCent =
      b.preco_promocional_centavos !== undefined
        ? b.preco_promocional_centavos
          ? Math.round(Number(b.preco_promocional_centavos))
          : null
        : existing.preco_promocional_centavos;

    const { error } = await sb
      .from('products')
      .update({
        category_id: b.categoria_id ?? existing.categoria_id,
        name: nome,
        name_normalized: normalizeText(nome),
        description: b.descricao_completa ?? existing.descricao_completa,
        short_description: b.observacao_curta ?? existing.observacao_curta,
        keywords: palavras,
        keywords_normalized: normalizeText(palavras),
        unit_type: unitType,
        price: Number((precoCent / 100).toFixed(2)),
        promo_price: promoCent !== null ? Number((promoCent / 100).toFixed(2)) : null,
        stock,
        low_stock_limit: b.estoque_baixo_limite !== undefined ? Number(b.estoque_baixo_limite) : existing.estoque_baixo_limite,
        active,
        featured: b.destaque !== undefined ? Boolean(b.destaque) : existing.destaque === 1,
        on_sale: b.oferta !== undefined ? Boolean(b.oferta) : existing.oferta === 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) throw new Error(error.message);
    return getProdutoById(id);
  }

  let nextSituacao = !active ? 'INATIVO' : stock <= 0 ? 'ESGOTADO' : 'DISPONIVEL';
  db.prepare(`
    UPDATE produtos SET
      categoria_id = ?, nome = ?, nome_normalizado = ?, descricao_completa = ?, observacao_curta = ?,
      palavras_chave = ?, palavras_chave_normalizadas = ?, preco_centavos = ?, preco_promocional_centavos = ?,
      estoque_quantidade = ?, estoque_baixo_limite = ?, unidade_venda = ?, modalidade_venda = ?,
      precisao_pesagem = ?, permite_parcelamento = 0, max_parcelas_produto = 1, situacao = ?,
      destaque = ?, oferta = ?, atualizado_em = datetime('now')
    WHERE id = ?
  `).run(
    b.categoria_id ?? existing.categoria_id,
    nome,
    normalizeText(nome),
    b.descricao_completa ?? existing.descricao_completa,
    b.observacao_curta ?? existing.observacao_curta,
    palavras,
    normalizeText(palavras),
    b.preco_centavos !== undefined ? Math.round(Number(b.preco_centavos)) : existing.preco_centavos,
    b.preco_promocional_centavos !== undefined
      ? b.preco_promocional_centavos
        ? Math.round(Number(b.preco_promocional_centavos))
        : null
      : existing.preco_promocional_centavos,
    stock,
    b.estoque_baixo_limite !== undefined ? Number(b.estoque_baixo_limite) : existing.estoque_baixo_limite,
    unitType === 'kg' ? 'KG' : 'UN',
    unitType === 'kg' ? 'PESO_KG' : 'UNIDADE',
    unitType === 'kg' ? 3 : 0,
    nextSituacao,
    b.destaque !== undefined ? (b.destaque ? 1 : 0) : existing.destaque,
    b.oferta !== undefined ? (b.oferta ? 1 : 0) : existing.oferta,
    id
  );
  return getProdutoById(id);
}

export async function deleteOrInactivateProduto(id: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { error } = await sb.from('products').delete().eq('id', id);
    if (error) {
      await sb.from('products').update({ active: false, updated_at: new Date().toISOString() }).eq('id', id);
      return { ok: true, inactivated: true };
    }
    return { ok: true };
  }

  const hasOrders = db.prepare(`SELECT COUNT(*) as total FROM itens_pedido WHERE produto_id = ?`).get(id) as { total: number };
  if (hasOrders.total > 0) {
    db.prepare(`UPDATE produtos SET situacao = 'INATIVO', atualizado_em = datetime('now') WHERE id = ?`).run(id);
    return { ok: true, inactivated: true };
  }
  db.prepare(`DELETE FROM produtos WHERE id = ?`).run(id);
  return { ok: true };
}

export async function uploadProductImages(produtoId: string, files: Express.Multer.File[]) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: prod } = await sb
      .from('products')
      .select('image_url, gallery_urls')
      .eq('id', produtoId)
      .maybeSingle();
    if (!prod) throw new Error('Produto não encontrado.');

    const gallery: string[] = Array.isArray(prod.gallery_urls) ? [...prod.gallery_urls] : [];
    let mainUrl: string | null = prod.image_url || null;
    if (mainUrl && !gallery.includes(mainUrl)) gallery.unshift(mainUrl);

    const created: any[] = [];
    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      const storagePath = `${produtoId}/${crypto.randomUUID()}${ext}`;
      const buffer = fs.readFileSync(file.path);

      const { error: upErr } = await sb.storage.from('produtos').upload(storagePath, buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      if (upErr) throw new Error(`Erro no Supabase Storage: ${upErr.message}`);

      const { data: pub } = sb.storage.from('produtos').getPublicUrl(storagePath);
      if (!mainUrl) mainUrl = pub.publicUrl;
      gallery.push(pub.publicUrl);
      created.push({
        id: `${produtoId}::img::${gallery.length - 1}`,
        produto_id: produtoId,
        url: pub.publicUrl,
        principal: mainUrl === pub.publicUrl ? 1 : 0,
      });
    }

    await sb
      .from('products')
      .update({
        image_url: mainUrl,
        gallery_urls: gallery,
        updated_at: new Date().toISOString(),
      })
      .eq('id', produtoId);

    return created;
  }

  const existingCount = db
    .prepare(`SELECT COUNT(*) as total FROM imagens_produtos WHERE produto_id = ?`)
    .get(produtoId) as { total: number };

  const insertImg = db.prepare(`
    INSERT INTO imagens_produtos (id, produto_id, url, nome_arquivo, principal, ordem)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const created: any[] = [];
  files.forEach((file, idx) => {
    const id = crypto.randomUUID();
    const url = `/uploads/produtos/${file.filename}`;
    const isPrimary = existingCount.total === 0 && idx === 0 ? 1 : 0;
    insertImg.run(id, produtoId, url, file.originalname, isPrimary, existingCount.total + idx);
    created.push({ id, url, principal: isPrimary });
  });
  return created;
}

export async function deleteProductImage(produtoId: string, imgId: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const idxMatch = imgId.split('::img::')[1];
    const idx = Number(idxMatch);
    const { data: prod } = await sb.from('products').select('image_url, gallery_urls').eq('id', produtoId).maybeSingle();
    if (!prod || Number.isNaN(idx)) return false;

    const urls: string[] = [];
    if (prod.image_url) urls.push(prod.image_url);
    if (Array.isArray(prod.gallery_urls)) {
      for (const u of prod.gallery_urls) {
        if (typeof u === 'string' && !urls.includes(u)) urls.push(u);
      }
    }
    const targetUrl = urls[idx];
    if (!targetUrl) return false;

    const marker = '/storage/v1/object/public/produtos/';
    const mIdx = targetUrl.indexOf(marker);
    if (mIdx !== -1) {
      await sb.storage.from('produtos').remove([targetUrl.slice(mIdx + marker.length)]);
    }

    const nextUrls = urls.filter((_, i) => i !== idx);
    await sb
      .from('products')
      .update({
        image_url: nextUrls[0] || null,
        gallery_urls: nextUrls,
        updated_at: new Date().toISOString(),
      })
      .eq('id', produtoId);
    return true;
  }

  const img = db.prepare(`SELECT * FROM imagens_produtos WHERE id = ? AND produto_id = ?`).get(imgId, produtoId) as any;
  if (!img) return false;
  if (img.url.startsWith('/uploads/produtos/')) {
    const filePath = path.join(uploadsDir, path.basename(img.url));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.prepare(`DELETE FROM imagens_produtos WHERE id = ?`).run(img.id);
  return true;
}

export async function setPrimaryProductImage(produtoId: string, imgId: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const idx = Number(imgId.split('::img::')[1]);
    const { data: prod } = await sb.from('products').select('image_url, gallery_urls').eq('id', produtoId).maybeSingle();
    if (!prod || Number.isNaN(idx)) return;
    const urls: string[] = [];
    if (prod.image_url) urls.push(prod.image_url);
    if (Array.isArray(prod.gallery_urls)) {
      for (const u of prod.gallery_urls) {
        if (typeof u === 'string' && !urls.includes(u)) urls.push(u);
      }
    }
    if (urls[idx]) {
      const chosen = urls[idx];
      const reordered = [chosen, ...urls.filter((_, i) => i !== idx)];
      await sb.from('products').update({ image_url: chosen, gallery_urls: reordered }).eq('id', produtoId);
    }
    return;
  }
  db.prepare(`UPDATE imagens_produtos SET principal = 0 WHERE produto_id = ?`).run(produtoId);
  db.prepare(`UPDATE imagens_produtos SET principal = 1 WHERE id = ? AND produto_id = ?`).run(imgId, produtoId);
}

// ==============================================================================
// PERSISTENT CART (Shipping strictly R$ 4,99 when cart has items)
// ==============================================================================

export async function getCartPayload(clienteId: string) {
  const freteCentavos = 499;
  const sb = getSupabaseAdmin();

  if (sb) {
    const { data: cartRow } = await sb.from('carrinhos').select('id').eq('cliente_id', clienteId).maybeSingle();
    if (!cartRow) {
      return { carrinho_id: null, itens: [], subtotal_centavos: 0, frete_centavos: 0, total_centavos: 0 };
    }
    const { data: rows } = await sb
      .from('itens_carrinho')
      .select('*, products(name, short_description, unit_type, price, promo_price, on_sale, stock, active, image_url)')
      .eq('carrinho_id', cartRow.id)
      .order('criado_em', { ascending: true });

    const itens = (rows || []).map((r: any) => {
      const p = r.products;
      const unitType: 'kg' | 'un' = p?.unit_type === 'kg' ? 'kg' : 'un';
      const stock = Number(p?.stock ?? 0);
      return {
        ...r,
        quantidade: Number(r.quantidade),
        produto_nome: p?.name,
        observacao_curta: p?.short_description || '',
        unit_type: unitType,
        unidade_venda: unitType === 'kg' ? 'KG' : 'UN',
        modalidade_venda: unitType === 'kg' ? 'PESO_KG' : 'UNIDADE',
        precisao_pesagem: unitType === 'kg' ? 3 : 0,
        estoque_quantidade: stock,
        situacao: !p?.active ? 'INATIVO' : stock <= 0 ? 'ESGOTADO' : 'DISPONIVEL',
        max_parcelas_produto: 1,
        imagem_principal: p?.image_url || null,
      };
    });

    const subtotalCentavos = itens.reduce((acc, it) => acc + Number(it.subtotal_centavos), 0);
    const frete = itens.length > 0 ? freteCentavos : 0;
    return {
      carrinho_id: cartRow.id,
      itens,
      subtotal_centavos: subtotalCentavos,
      frete_centavos: frete,
      total_centavos: subtotalCentavos + frete,
    };
  }

  const cartRow = db.prepare(`SELECT id FROM carrinhos WHERE cliente_id = ?`).get(clienteId) as { id: string } | undefined;
  if (!cartRow) {
    return { carrinho_id: null, itens: [], subtotal_centavos: 0, frete_centavos: 0, total_centavos: 0 };
  }
  const rows = db
    .prepare(`
      SELECT ic.*, p.nome as produto_nome, p.observacao_curta, p.unidade_venda,
             p.modalidade_venda, p.precisao_pesagem, p.estoque_quantidade, p.situacao,
             p.preco_centavos, p.preco_promocional_centavos, p.oferta
      FROM itens_carrinho ic
      JOIN produtos p ON p.id = ic.produto_id
      WHERE ic.carrinho_id = ?
      ORDER BY ic.criado_em ASC
    `)
    .all(cartRow.id) as any[];

  const imgs = db.prepare(`SELECT produto_id, url FROM imagens_produtos ORDER BY principal DESC, ordem ASC`).all() as {
    produto_id: string;
    url: string;
  }[];
  const imgMap = new Map<string, string>();
  for (const i of imgs) {
    if (!imgMap.has(i.produto_id)) imgMap.set(i.produto_id, i.url);
  }
  const itens = rows.map((r) => {
    const unitType = resolveUnitType(r.modalidade_venda);
    return {
      ...r,
      unit_type: unitType,
      unidade_venda: unitType === 'kg' ? 'KG' : 'UN',
      modalidade_venda: unitType === 'kg' ? 'PESO_KG' : 'UNIDADE',
      max_parcelas_produto: 1,
      imagem_principal: imgMap.get(r.produto_id) || null,
    };
  });
  const subtotalCentavos = itens.reduce((acc, it) => acc + Number(it.subtotal_centavos), 0);
  const frete = itens.length > 0 ? freteCentavos : 0;
  return {
    carrinho_id: cartRow.id,
    itens,
    subtotal_centavos: subtotalCentavos,
    frete_centavos: frete,
    total_centavos: subtotalCentavos + frete,
  };
}

export async function ensureProfileExists(clienteId: string) {
  const sb = getSupabaseAdmin();
  if (!sb) {
    console.warn('[DIAGNOSTICO CART] Supabase admin client não configurado ao verificar perfil para ID:', clienteId);
    return;
  }

  const projectUrl = resolveSupabaseUrl();
  const projectRef = extractProjectRefFromUrl(projectUrl);
  console.info(`[DIAGNOSTICO CART] Verificando perfil | ProjectRef: ${projectRef || 'desconhecido'} | ClienteId (UUID): ${clienteId}`);

  // 1. Check if profile exists
  const { data: prof, error: profErr } = await sb
    .from('profiles')
    .select('id, cpf, is_admin')
    .eq('id', clienteId)
    .maybeSingle();

  if (profErr) {
    console.error(`[DIAGNOSTICO CART] Erro ao consultar profiles para ID ${clienteId}:`, profErr.message);
    throw new Error(`Erro ao consultar perfil no Supabase: ${profErr.message}`);
  }

  console.info(`[DIAGNOSTICO CART] Consulta profiles concluída para ID ${clienteId}. Encontrado:`, Boolean(prof));

  if (prof) {
    return; // Profile exists
  }

  // 2. Fetch user from Supabase Auth
  const { data: authUserRes, error: authErr } = await sb.auth.admin.getUserById(clienteId);
  if (authErr || !authUserRes?.user) {
    console.error(`[DIAGNOSTICO CART] Usuário não encontrado no Supabase Auth para ID ${clienteId}:`, authErr?.message);
    throw new Error(`Usuário não encontrado no Supabase Auth (${clienteId}): ${authErr?.message || 'usuário inexistente'}`);
  }

  const authUser = authUserRes.user;
  const rawCpf = authUser.user_metadata?.cpf || authUser.email?.split('@')[0] || '';
  const cpf = cleanDigits(rawCpf);

  if (!cpf || cpf.length !== 11 || cpf === '00000000000') {
    console.error(`[DIAGNOSTICO CART] CPF inválido ou ausente para ID ${clienteId}`);
    throw new Error('CPF válido não encontrado nos metadados do usuário ou e-mail de autenticação.');
  }

  const fullName = String(authUser.user_metadata?.full_name || '').trim() || `Cliente ${cpf.slice(-4)}`;
  const email = authUser.email || `${cpf}@agromarconato.local`;
  const phone = cleanDigits(authUser.user_metadata?.phone || '');
  const isAdmin = cpf === ADMIN_MASTER_CPF;

  console.info(`[DIAGNOSTICO CART] Criando/atualizando perfil em public.profiles para ID ${clienteId} (admin: ${isAdmin})`);

  // 2.5 Clean up any stale profile with same cpf to avoid unique constraint violation on cpf
  await sb.from('profiles').delete().eq('cpf', cpf).neq('id', clienteId);

  // 3. Upsert profile with proper error propagation
  const { error: upsertErr } = await sb.from('profiles').upsert(
    {
      id: clienteId,
      cpf,
      full_name: fullName,
      phone,
      email,
      is_admin: isAdmin,
    },
    { onConflict: 'id' }
  );

  if (upsertErr) {
    console.error(`[DIAGNOSTICO CART] Erro no upsert de profiles para ID ${clienteId}:`, upsertErr.message);
    throw new Error(`Erro ao criar/atualizar perfil do usuário: ${upsertErr.message}`);
  }

  console.info(`[DIAGNOSTICO CART] Perfil criado/atualizado com sucesso em public.profiles para ID ${clienteId}`);
}

export async function getOrCreateCart(clienteId: string): Promise<string> {
  const sb = getSupabaseAdmin();
  if (sb) {
    if (!clienteId) {
      throw new Error('Identificador do cliente (clienteId) inválido ou ausente.');
    }

    // Ensure profile exists co-dependently; throws error if profile cannot be verified or created
    await ensureProfileExists(clienteId);

    // Double check profile exists before inserting into carrinhos
    const { data: profileCheck, error: profileCheckErr } = await sb
      .from('profiles')
      .select('id')
      .eq('id', clienteId)
      .maybeSingle();

    if (profileCheckErr || !profileCheck) {
      console.error(`[DIAGNOSTICO CART] Falha na validação final do perfil para ID ${clienteId}:`, profileCheckErr?.message);
      throw new Error('Não é possível criar o carrinho: perfil do cliente não encontrado.');
    }

    const { data: existing, error: existingErr } = await sb.from('carrinhos').select('id').eq('cliente_id', clienteId).maybeSingle();
    if (existingErr) {
      console.error(`[DIAGNOSTICO CART] Erro ao buscar carrinho para ID ${clienteId}:`, existingErr.message);
      throw new Error(`Erro ao buscar carrinho: ${existingErr.message}`);
    }
    if (existing) {
      console.info(`[DIAGNOSTICO CART] Carrinho existente encontrado para ID ${clienteId}:`, existing.id);
      return existing.id;
    }

    console.info(`[DIAGNOSTICO CART] Inserindo novo registro em public.carrinhos com cliente_id (UUID):`, clienteId);
    const { data, error } = await sb.from('carrinhos').insert({ cliente_id: clienteId }).select('id').single();
    if (error) {
      console.error(`[DIAGNOSTICO CART] ERRO CRÍTICO insert carrinhos para cliente_id ${clienteId}:`, error.message);
      throw new Error(`Erro ao criar carrinho: ${error.message}`);
    }

    console.info(`[DIAGNOSTICO CART] Carrinho criado com sucesso para cliente_id ${clienteId}. CartId:`, data.id);
    return data.id;
  }

  const existing = db.prepare(`SELECT id FROM carrinhos WHERE cliente_id = ?`).get(clienteId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO carrinhos (id, cliente_id) VALUES (?, ?)`).run(id, clienteId);
  return id;
}

export function getStorageModeInfo() {
  return {
    engine: isSupabaseConfigured() ? 'supabase' : 'sqlite-local',
    supabaseUrl: resolveSupabaseUrl(),
  };
}
