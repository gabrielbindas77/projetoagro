import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { db, getStoreConfig as getSqliteConfig, uploadsDir } from './db.ts';
import { getSupabaseAdmin, isSupabaseConfigured, ensureSupabaseAdminBootstrap } from './supabase.ts';
import { cleanDigits, normalizeText } from './utils.ts';

function boolNum(val: any): number {
  return val === true || val === 1 ? 1 : 0;
}

export async function getConfigMap(): Promise<Record<string, string>> {
  const sb = getSupabaseAdmin();
  if (sb) {
    const [{ data, error }, adminSettingsRes] = await Promise.all([
      sb.from('configuracoes_loja').select('chave, valor'),
      sb.from('admin_settings').select('pix_key, pix_key_type, pix_recipient_name, shipping_fee').eq('id', 1).maybeSingle(),
    ]);
    if (!error && data) {
      const map: Record<string, string> = {};
      for (const r of data) map[r.chave] = r.valor;
      if (adminSettingsRes.data) {
        if (adminSettingsRes.data.pix_key !== undefined) map.pix_key = adminSettingsRes.data.pix_key || '';
        if (adminSettingsRes.data.pix_key_type) map.pix_key_type = adminSettingsRes.data.pix_key_type;
        if (adminSettingsRes.data.pix_recipient_name) map.pix_recipient_name = adminSettingsRes.data.pix_recipient_name;
        if (adminSettingsRes.data.shipping_fee !== undefined && adminSettingsRes.data.shipping_fee !== null) {
          map.frete_padrao_centavos = String(Math.round(Number(adminSettingsRes.data.shipping_fee) * 100));
        }
      }
      return map;
    }
  }
  return getSqliteConfig();
}

export async function updateConfigMap(entries: Record<string, string>) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const rows = Object.entries(entries).map(([chave, valor]) => ({
      chave,
      valor: String(valor),
      atualizado_em: new Date().toISOString(),
    }));
    const { error } = await sb.from('configuracoes_loja').upsert(rows, { onConflict: 'chave' });
    if (error) throw new Error(error.message);

    // Mirror PIX and shipping settings into public.admin_settings if table exists
    const current = await getConfigMap();
    const freteCentavos = Number(entries.frete_padrao_centavos ?? current.frete_padrao_centavos ?? 499);
    await sb
      .from('admin_settings')
      .upsert(
        {
          id: 1,
          pix_key: entries.pix_key ?? current.pix_key ?? '',
          pix_key_type: entries.pix_key_type ?? current.pix_key_type ?? 'CPF',
          pix_recipient_name: entries.pix_recipient_name ?? current.pix_recipient_name ?? 'Agro Marconato Agropecuária',
          shipping_fee: Number((freteCentavos / 100).toFixed(2)),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      )
      .then(() => undefined, () => undefined);

    return getConfigMap();
  }
  const upsert = db.prepare(`
    INSERT INTO configuracoes_loja (chave, valor, atualizado_em)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = datetime('now')
  `);
  for (const [k, v] of Object.entries(entries)) upsert.run(k, String(v));
  return getSqliteConfig();
}

// ==============================================================================
// AUTH & RATE LIMIT
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
  const sb = getSupabaseAdmin();
  if (sb) {
    const [c1, a1, c2, a2] = await Promise.all([
      sb.from('clientes').select('id').eq('cpf', cpf).maybeSingle(),
      sb.from('administradores').select('id').eq('cpf', cpf).maybeSingle(),
      sb.from('clientes').select('id').eq('email', email).maybeSingle(),
      sb.from('administradores').select('id').eq('email', email).maybeSingle(),
    ]);
    return {
      cpfExists: Boolean(c1.data || a1.data),
      emailExists: Boolean(c2.data || a2.data),
    };
  }
  const existingCpf = db
    .prepare(`SELECT id FROM clientes WHERE cpf = ? UNION SELECT id FROM administradores WHERE cpf = ?`)
    .get(cpf, cpf);
  const existingEmail = db
    .prepare(`SELECT id FROM clientes WHERE email = ? UNION SELECT id FROM administradores WHERE email = ?`)
    .get(email, email);
  return { cpfExists: Boolean(existingCpf), emailExists: Boolean(existingEmail) };
}

export async function createCliente(input: {
  nome_completo: string;
  cpf: string;
  email: string;
  telefone: string;
  senha_hash: string;
  identidade_verificada: boolean;
}) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from('clientes')
      .insert({
        nome_completo: input.nome_completo,
        cpf: input.cpf,
        email: input.email,
        telefone: input.telefone,
        senha_hash: input.senha_hash,
        identidade_verificada: input.identidade_verificada,
        papel: 'CLIENTE',
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO clientes (id, nome_completo, cpf, email, telefone, senha_hash, email_verificado, telefone_verificado, identidade_verificada, papel)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 'CLIENTE')
  `).run(id, input.nome_completo, input.cpf, input.email, input.telefone, input.senha_hash, input.identidade_verificada ? 1 : 0);
  return db.prepare(`SELECT * FROM clientes WHERE id = ?`).get(id);
}

export async function findAuthAccountByCpf(cpf: string): Promise<{ account: any; papel: 'ADMIN' | 'CLIENTE' } | null> {
  const sb = getSupabaseAdmin();
  if (sb) {
    await ensureSupabaseAdminBootstrap();
    const { data: admin } = await sb
      .from('administradores')
      .select('*')
      .eq('cpf', cpf)
      .eq('ativo', true)
      .maybeSingle();
    if (admin) return { account: admin, papel: 'ADMIN' };

    const { data: cliente } = await sb.from('clientes').select('*').eq('cpf', cpf).maybeSingle();
    if (cliente) return { account: cliente, papel: 'CLIENTE' };
    return null;
  }

  const admin = db.prepare(`SELECT * FROM administradores WHERE cpf = ? AND ativo = 1`).get(cpf) as any;
  if (admin) return { account: admin, papel: 'ADMIN' };
  const cliente = db.prepare(`SELECT * FROM clientes WHERE cpf = ?`).get(cpf) as any;
  if (cliente) return { account: cliente, papel: 'CLIENTE' };
  return null;
}

export async function getUserProfileById(id: string, papel: 'ADMIN' | 'CLIENTE') {
  const sb = getSupabaseAdmin();
  if (sb) {
    if (papel === 'ADMIN') {
      const { data } = await sb
        .from('administradores')
        .select('id, nome_completo, cpf, email, telefone, papel')
        .eq('id', id)
        .eq('ativo', true)
        .maybeSingle();
      return data || null;
    }
    const { data } = await sb
      .from('clientes')
      .select('id, nome_completo, cpf, email, telefone, papel, email_verificado, telefone_verificado, identidade_verificada')
      .eq('id', id)
      .maybeSingle();
    return data || null;
  }

  if (papel === 'ADMIN') {
    return (
      db
        .prepare(`SELECT id, nome_completo, cpf, email, telefone, papel FROM administradores WHERE id = ? AND ativo = 1`)
        .get(id) || null
    );
  }
  const cliente = db
    .prepare(
      `SELECT id, nome_completo, cpf, email, telefone, papel, email_verificado, telefone_verificado, identidade_verificada FROM clientes WHERE id = ?`
    )
    .get(id) as any;
  if (!cliente) return null;
  return {
    ...cliente,
    email_verificado: cliente.email_verificado === 1,
    telefone_verificado: cliente.telefone_verificado === 1,
    identidade_verificada: cliente.identidade_verificada === 1,
  };
}

export async function saveVerificationCode(alvo: string, tipo: string, codigoHash: string, expiraEm: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    await sb.from('codigos_verificacao').insert({ alvo, tipo, codigo_hash: codigoHash, expira_em: expiraEm });
    return;
  }
  db.prepare(`
    INSERT INTO codigos_verificacao (id, alvo, tipo, codigo_hash, expira_em)
    VALUES (?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), alvo, tipo, codigoHash, expiraEm);
}

export async function verifyAndConsumeCode(alvo: string, tipo: string, codigoHash: string): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data } = await sb
      .from('codigos_verificacao')
      .select('*')
      .eq('alvo', alvo)
      .eq('tipo', tipo)
      .eq('usado', false)
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return { ok: false, error: 'Nenhum código ativo encontrado. Solicite um novo envio.' };
    if (new Date(data.expira_em).getTime() < Date.now()) return { ok: false, error: 'Código expirado.' };
    if (data.codigo_hash !== codigoHash) return { ok: false, error: 'Código incorreto.' };

    await sb.from('codigos_verificacao').update({ usado: true }).eq('id', data.id);
    return { ok: true };
  }

  const row = db
    .prepare(`
      SELECT id, codigo_hash, expira_em FROM codigos_verificacao
      WHERE alvo = ? AND tipo = ? AND usado = 0
      ORDER BY criado_em DESC LIMIT 1
    `)
    .get(alvo, tipo) as { id: string; codigo_hash: string; expira_em: string } | undefined;

  if (!row) return { ok: false, error: 'Nenhum código ativo encontrado. Solicite um novo envio.' };
  if (new Date(row.expira_em).getTime() < Date.now()) return { ok: false, error: 'Código expirado.' };
  if (row.codigo_hash !== codigoHash) return { ok: false, error: 'Código incorreto.' };
  db.prepare(`UPDATE codigos_verificacao SET usado = 1 WHERE id = ?`).run(row.id);
  return { ok: true };
}

export async function markClienteVerified(clienteId: string, field: 'EMAIL' | 'TELEFONE') {
  const sb = getSupabaseAdmin();
  if (sb) {
    const patch = field === 'EMAIL' ? { email_verificado: true } : { telefone_verificado: true };
    await sb.from('clientes').update({ ...patch, atualizado_em: new Date().toISOString() }).eq('id', clienteId);
    return;
  }
  if (field === 'EMAIL') {
    db.prepare(`UPDATE clientes SET email_verificado = 1, atualizado_em = datetime('now') WHERE id = ?`).run(clienteId);
  } else {
    db.prepare(`UPDATE clientes SET telefone_verificado = 1, atualizado_em = datetime('now') WHERE id = ?`).run(clienteId);
  }
}

export async function updateClientePasswordByCpf(cpf: string, senhaHash: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    await sb.from('clientes').update({ senha_hash: senhaHash, atualizado_em: new Date().toISOString() }).eq('cpf', cpf);
    return;
  }
  db.prepare(`UPDATE clientes SET senha_hash = ?, atualizado_em = datetime('now') WHERE cpf = ?`).run(senhaHash, cpf);
}

// ==============================================================================
// CATEGORIES & PRODUCTS + REAL IMAGE STORAGE
// ==============================================================================

export async function listCategorias() {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb.from('categorias').select('*').order('ordem', { ascending: true }).order('nome', { ascending: true });
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

function normalizeProductRow(p: any, catName?: string, catSlug?: string, imgs: any[] = []) {
  const primary = imgs.find((i) => boolNum(i.principal) === 1) || imgs[0] || null;
  return {
    ...p,
    preco_centavos: Number(p.preco_centavos),
    preco_promocional_centavos: p.preco_promocional_centavos !== null ? Number(p.preco_promocional_centavos) : null,
    estoque_quantidade: Number(p.estoque_quantidade),
    estoque_baixo_limite: Number(p.estoque_baixo_limite),
    precisao_pesagem: Number(p.precisao_pesagem),
    permite_parcelamento: boolNum(p.permite_parcelamento),
    max_parcelas_produto: Number(p.max_parcelas_produto),
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
    let q = sb.from('produtos').select('*, categorias(nome, slug)').order('destaque', { ascending: false }).order('criado_em', { ascending: false });
    if (!includeInactive) q = q.neq('situacao', 'INATIVO');
    const { data: prods, error } = await q;
    if (error) throw new Error(error.message);

    const { data: imgs } = await sb
      .from('imagens_produtos')
      .select('*')
      .order('principal', { ascending: false })
      .order('ordem', { ascending: true });

    const byProd = new Map<string, any[]>();
    for (const img of imgs || []) {
      const arr = byProd.get(img.produto_id) || [];
      arr.push(img);
      byProd.set(img.produto_id, arr);
    }

    return (prods || []).map((p: any) =>
      normalizeProductRow(p, p.categorias?.nome, p.categorias?.slug, byProd.get(p.id) || [])
    );
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
  return rows.map((p) => normalizeProductRow(p, p.categoria_nome, p.categoria_slug, byProd.get(p.id) || []));
}

export async function getProdutoById(id: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: p } = await sb.from('produtos').select('*, categorias(nome, slug)').eq('id', id).maybeSingle();
    if (!p) return null;
    const { data: imgs } = await sb
      .from('imagens_produtos')
      .select('*')
      .eq('produto_id', id)
      .order('principal', { ascending: false })
      .order('ordem', { ascending: true });
    return normalizeProductRow(p, p.categorias?.nome, p.categorias?.slug, imgs || []);
  }
  const row = db
    .prepare(`
      SELECT p.*, c.nome as categoria_nome, c.slug as categoria_slug
      FROM produtos p JOIN categorias c ON c.id = p.categoria_id WHERE p.id = ?
    `)
    .get(id) as any;
  if (!row) return null;
  const imgs = db.prepare(`SELECT * FROM imagens_produtos WHERE produto_id = ? ORDER BY principal DESC, ordem ASC`).all(id) as any[];
  return normalizeProductRow(row, row.categoria_nome, row.categoria_slug, imgs);
}

export async function createProduto(input: any) {
  const stock = Math.max(0, Number(input.estoque_quantidade || 0));
  const computedSituacao = input.situacao === 'INATIVO' ? 'INATIVO' : stock <= 0 ? 'ESGOTADO' : 'DISPONIVEL';
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from('produtos')
      .insert({
        categoria_id: input.categoria_id,
        nome: String(input.nome).trim(),
        nome_normalizado: normalizeText(String(input.nome)),
        descricao_completa: String(input.descricao_completa).trim(),
        observacao_curta: String(input.observacao_curta).trim(),
        palavras_chave: String(input.palavras_chave || ''),
        palavras_chave_normalizadas: normalizeText(String(input.palavras_chave || '')),
        preco_centavos: Math.round(Number(input.preco_centavos)),
        preco_promocional_centavos: input.preco_promocional_centavos ? Math.round(Number(input.preco_promocional_centavos)) : null,
        estoque_quantidade: stock,
        estoque_baixo_limite: Number(input.estoque_baixo_limite ?? 5),
        unidade_venda: input.unidade_venda || 'UN',
        modalidade_venda: input.modalidade_venda || 'UNIDADE',
        precisao_pesagem: Number(input.precisao_pesagem ?? 3),
        permite_parcelamento: false,
        max_parcelas_produto: 1,
        situacao: computedSituacao,
        destaque: Boolean(input.destaque),
        oferta: Boolean(input.oferta),
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return getProdutoById(data.id);
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO produtos (
      id, categoria_id, nome, nome_normalizado, descricao_completa, observacao_curta,
      palavras_chave, palavras_chave_normalizadas, preco_centavos, preco_promocional_centavos,
      estoque_quantidade, estoque_baixo_limite, unidade_venda, modalidade_venda,
      precisao_pesagem, permite_parcelamento, max_parcelas_produto, situacao, destaque, oferta
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    input.unidade_venda || 'UN',
    input.modalidade_venda || 'UNIDADE',
    Number(input.precisao_pesagem ?? 3),
    0,
    1,
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
  let nextSituacao = b.situacao !== undefined ? b.situacao : existing.situacao;
  if (nextSituacao !== 'INATIVO') {
    nextSituacao = stock <= 0 ? 'ESGOTADO' : 'DISPONIVEL';
  }

  const sb = getSupabaseAdmin();
  if (sb) {
    const { error } = await sb
      .from('produtos')
      .update({
        categoria_id: b.categoria_id ?? existing.categoria_id,
        nome,
        nome_normalizado: normalizeText(nome),
        descricao_completa: b.descricao_completa ?? existing.descricao_completa,
        observacao_curta: b.observacao_curta ?? existing.observacao_curta,
        palavras_chave: palavras,
        palavras_chave_normalizadas: normalizeText(palavras),
        preco_centavos: b.preco_centavos !== undefined ? Math.round(Number(b.preco_centavos)) : existing.preco_centavos,
        preco_promocional_centavos:
          b.preco_promocional_centavos !== undefined
            ? b.preco_promocional_centavos
              ? Math.round(Number(b.preco_promocional_centavos))
              : null
            : existing.preco_promocional_centavos,
        estoque_quantidade: stock,
        estoque_baixo_limite: b.estoque_baixo_limite !== undefined ? Number(b.estoque_baixo_limite) : existing.estoque_baixo_limite,
        unidade_venda: b.unidade_venda ?? existing.unidade_venda,
        modalidade_venda: b.modalidade_venda ?? existing.modalidade_venda,
        precisao_pesagem: b.precisao_pesagem !== undefined ? Number(b.precisao_pesagem) : existing.precisao_pesagem,
        permite_parcelamento: b.permite_parcelamento !== undefined ? Boolean(b.permite_parcelamento) : existing.permite_parcelamento === 1,
        max_parcelas_produto: b.max_parcelas_produto !== undefined ? Number(b.max_parcelas_produto) : existing.max_parcelas_produto,
        situacao: nextSituacao,
        destaque: b.destaque !== undefined ? Boolean(b.destaque) : existing.destaque === 1,
        oferta: b.oferta !== undefined ? Boolean(b.oferta) : existing.oferta === 1,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) throw new Error(error.message);
    return getProdutoById(id);
  }

  db.prepare(`
    UPDATE produtos SET
      categoria_id = ?, nome = ?, nome_normalizado = ?, descricao_completa = ?, observacao_curta = ?,
      palavras_chave = ?, palavras_chave_normalizadas = ?, preco_centavos = ?, preco_promocional_centavos = ?,
      estoque_quantidade = ?, estoque_baixo_limite = ?, unidade_venda = ?, modalidade_venda = ?,
      precisao_pesagem = ?, permite_parcelamento = ?, max_parcelas_produto = ?, situacao = ?,
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
    b.unidade_venda ?? existing.unidade_venda,
    b.modalidade_venda ?? existing.modalidade_venda,
    b.precisao_pesagem !== undefined ? Number(b.precisao_pesagem) : existing.precisao_pesagem,
    b.permite_parcelamento !== undefined ? (b.permite_parcelamento ? 1 : 0) : existing.permite_parcelamento,
    b.max_parcelas_produto !== undefined ? Number(b.max_parcelas_produto) : existing.max_parcelas_produto,
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
    const { count } = await sb.from('itens_pedido').select('id', { count: 'exact', head: true }).eq('produto_id', id);
    if ((count || 0) > 0) {
      await sb.from('produtos').update({ situacao: 'INATIVO', atualizado_em: new Date().toISOString() }).eq('id', id);
      return { ok: true, inactivated: true };
    }
    await sb.from('produtos').delete().eq('id', id);
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
    const { count } = await sb
      .from('imagens_produtos')
      .select('id', { count: 'exact', head: true })
      .eq('produto_id', produtoId);
    const existingCount = count || 0;
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

      // Remove temporary local file after uploading to Supabase Storage
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

      if (upErr) throw new Error(`Erro no Supabase Storage: ${upErr.message}`);

      const { data: pub } = sb.storage.from('produtos').getPublicUrl(storagePath);
      const isPrimary = existingCount === 0 && idx === 0;

      const { data: imgRow, error: insErr } = await sb
        .from('imagens_produtos')
        .insert({
          produto_id: produtoId,
          url: pub.publicUrl,
          nome_arquivo: file.originalname,
          principal: isPrimary,
          ordem: existingCount + idx,
        })
        .select('*')
        .single();
      if (insErr) throw new Error(insErr.message);
      created.push(imgRow);
    }
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
    const { data: img } = await sb
      .from('imagens_produtos')
      .select('*')
      .eq('id', imgId)
      .eq('produto_id', produtoId)
      .maybeSingle();
    if (!img) return false;
    const marker = '/storage/v1/object/public/produtos/';
    const idx = img.url.indexOf(marker);
    if (idx !== -1) {
      const objectPath = img.url.slice(idx + marker.length);
      await sb.storage.from('produtos').remove([objectPath]);
    }
    await sb.from('imagens_produtos').delete().eq('id', imgId);
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
    await sb.from('imagens_produtos').update({ principal: false }).eq('produto_id', produtoId);
    await sb.from('imagens_produtos').update({ principal: true }).eq('id', imgId).eq('produto_id', produtoId);
    return;
  }
  db.prepare(`UPDATE imagens_produtos SET principal = 0 WHERE produto_id = ?`).run(produtoId);
  db.prepare(`UPDATE imagens_produtos SET principal = 1 WHERE id = ? AND produto_id = ?`).run(imgId, produtoId);
}

// ==============================================================================
// PERSISTENT CART
// ==============================================================================

export async function getCartPayload(clienteId: string) {
  const cfg = await getConfigMap();
  const freteCentavos = Number(cfg.frete_padrao_centavos || 1500);
  const sb = getSupabaseAdmin();

  if (sb) {
    const { data: cartRow } = await sb.from('carrinhos').select('id').eq('cliente_id', clienteId).maybeSingle();
    if (!cartRow) {
      return { carrinho_id: null, itens: [], subtotal_centavos: 0, frete_centavos: 0, total_centavos: 0 };
    }
    const { data: rows } = await sb
      .from('itens_carrinho')
      .select('*, produtos(nome, observacao_curta, unidade_venda, modalidade_venda, precisao_pesagem, estoque_quantidade, situacao, preco_centavos, preco_promocional_centavos, oferta, max_parcelas_produto)')
      .eq('carrinho_id', cartRow.id)
      .order('criado_em', { ascending: true });

    const { data: imgs } = await sb
      .from('imagens_produtos')
      .select('produto_id, url')
      .order('principal', { ascending: false })
      .order('ordem', { ascending: true });

    const imgMap = new Map<string, string>();
    for (const i of imgs || []) {
      if (!imgMap.has(i.produto_id)) imgMap.set(i.produto_id, i.url);
    }

    const itens = (rows || []).map((r: any) => ({
      ...r,
      quantidade: Number(r.quantidade),
      produto_nome: r.produtos?.nome,
      observacao_curta: r.produtos?.observacao_curta,
      unidade_venda: r.produtos?.unidade_venda,
      modalidade_venda: r.produtos?.modalidade_venda,
      precisao_pesagem: r.produtos?.precisao_pesagem ?? 3,
      estoque_quantidade: Number(r.produtos?.estoque_quantidade ?? 0),
      situacao: r.produtos?.situacao,
      preco_centavos: r.produtos?.preco_centavos,
      preco_promocional_centavos: r.produtos?.preco_promocional_centavos,
      oferta: boolNum(r.produtos?.oferta),
      max_parcelas_produto: r.produtos?.max_parcelas_produto ?? 6,
      imagem_principal: imgMap.get(r.produto_id) || null,
    }));

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
             p.preco_centavos, p.preco_promocional_centavos, p.oferta, p.max_parcelas_produto
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
  const itens = rows.map((r) => ({ ...r, imagem_principal: imgMap.get(r.produto_id) || null }));
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

export async function getOrCreateCart(clienteId: string): Promise<string> {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: existing } = await sb.from('carrinhos').select('id').eq('cliente_id', clienteId).maybeSingle();
    if (existing) return existing.id;
    const { data, error } = await sb.from('carrinhos').insert({ cliente_id: clienteId }).select('id').single();
    if (error) throw new Error(error.message);
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
    supabaseUrl: process.env.SUPABASE_URL || '',
  };
}
