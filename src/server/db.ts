import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { cleanDigits, normalizeText } from './utils.ts';

const baseWritableDir = process.env.VERCEL ? '/tmp/agro-marconato' : process.cwd();
const dataDir = path.resolve(baseWritableDir, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const uploadsDir = path.resolve(baseWritableDir, 'uploads', 'produtos');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'agro_marconato.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clientes (
      id TEXT PRIMARY KEY,
      nome_completo TEXT NOT NULL,
      cpf TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      telefone TEXT NOT NULL,
      senha_hash TEXT NOT NULL,
      email_verificado INTEGER NOT NULL DEFAULT 0,
      telefone_verificado INTEGER NOT NULL DEFAULT 0,
      identidade_verificada INTEGER NOT NULL DEFAULT 0,
      papel TEXT NOT NULL DEFAULT 'CLIENTE' CHECK (papel = 'CLIENTE'),
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS administradores (
      id TEXT PRIMARY KEY,
      nome_completo TEXT NOT NULL,
      cpf TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      telefone TEXT NOT NULL,
      senha_hash TEXT NOT NULL,
      papel TEXT NOT NULL DEFAULT 'ADMIN' CHECK (papel = 'ADMIN'),
      criado_por TEXT REFERENCES administradores(id),
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS codigos_verificacao (
      id TEXT PRIMARY KEY,
      alvo TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('EMAIL', 'TELEFONE', 'RECUPERACAO_SENHA')),
      codigo_hash TEXT NOT NULL,
      expira_em TEXT NOT NULL,
      usado INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tentativas_login (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT NOT NULL UNIQUE,
      tentativas INTEGER NOT NULL DEFAULT 0,
      bloqueado_ate TEXT,
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS enderecos (
      id TEXT PRIMARY KEY,
      cliente_id TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      cep TEXT NOT NULL,
      rua TEXT NOT NULL,
      numero TEXT NOT NULL,
      complemento TEXT DEFAULT '',
      bairro TEXT NOT NULL,
      cidade TEXT NOT NULL,
      estado TEXT NOT NULL,
      padrao INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categorias (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      descricao TEXT DEFAULT '',
      ordem INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS produtos (
      id TEXT PRIMARY KEY,
      categoria_id TEXT NOT NULL REFERENCES categorias(id),
      nome TEXT NOT NULL,
      nome_normalizado TEXT NOT NULL,
      descricao_completa TEXT NOT NULL,
      observacao_curta TEXT NOT NULL,
      palavras_chave TEXT NOT NULL DEFAULT '',
      palavras_chave_normalizadas TEXT NOT NULL DEFAULT '',
      preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
      preco_promocional_centavos INTEGER,
      estoque_quantidade REAL NOT NULL DEFAULT 0 CHECK (estoque_quantidade >= 0),
      estoque_baixo_limite REAL NOT NULL DEFAULT 5,
      unidade_venda TEXT NOT NULL DEFAULT 'UN',
      modalidade_venda TEXT NOT NULL CHECK (modalidade_venda IN ('UNIDADE', 'PESO_KG', 'VALOR_DINHEIRO', 'PESO_E_VALOR')),
      precisao_pesagem INTEGER NOT NULL DEFAULT 3,
      permite_parcelamento INTEGER NOT NULL DEFAULT 0,
      max_parcelas_produto INTEGER NOT NULL DEFAULT 1,
      situacao TEXT NOT NULL DEFAULT 'DISPONIVEL' CHECK (situacao IN ('DISPONIVEL', 'ESGOTADO', 'INATIVO')),
      destaque INTEGER NOT NULL DEFAULT 0,
      oferta INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS imagens_produtos (
      id TEXT PRIMARY KEY,
      produto_id TEXT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      nome_arquivo TEXT,
      principal INTEGER NOT NULL DEFAULT 0,
      ordem INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS carrinhos (
      id TEXT PRIMARY KEY,
      cliente_id TEXT NOT NULL UNIQUE REFERENCES clientes(id) ON DELETE CASCADE,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS itens_carrinho (
      id TEXT PRIMARY KEY,
      carrinho_id TEXT NOT NULL REFERENCES carrinhos(id) ON DELETE CASCADE,
      produto_id TEXT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
      modo_compra TEXT NOT NULL CHECK (modo_compra IN ('UNIDADE', 'PESO_KG', 'VALOR_DINHEIRO')),
      quantidade REAL NOT NULL CHECK (quantidade > 0),
      valor_desejado_centavos INTEGER,
      preco_unitario_snapshot_centavos INTEGER NOT NULL,
      subtotal_centavos INTEGER NOT NULL,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id TEXT PRIMARY KEY,
      numero_pedido INTEGER NOT NULL UNIQUE,
      cliente_id TEXT NOT NULL REFERENCES clientes(id),
      endereco_cep TEXT NOT NULL,
      endereco_rua TEXT NOT NULL,
      endereco_numero TEXT NOT NULL,
      endereco_complemento TEXT DEFAULT '',
      endereco_bairro TEXT NOT NULL,
      endereco_cidade TEXT NOT NULL,
      endereco_estado TEXT NOT NULL,
      subtotal_centavos INTEGER NOT NULL,
      frete_centavos INTEGER NOT NULL,
      total_centavos INTEGER NOT NULL,
      forma_pagamento TEXT NOT NULL CHECK (forma_pagamento IN ('PIX', 'CARTAO_CREDITO', 'DINHEIRO_NA_ENTREGA')),
      parcelas INTEGER NOT NULL DEFAULT 1,
      situacao_financeira TEXT NOT NULL CHECK (situacao_financeira IN ('AGUARDANDO_PAGAMENTO', 'PAGO', 'RECUSADO', 'CANCELADO', 'ESTORNADO')),
      situacao_entrega TEXT NOT NULL CHECK (situacao_entrega IN ('CONFIRMADO', 'EM_PREPARACAO', 'SAIU_PARA_ENTREGA', 'ENTREGUE', 'CANCELADO')),
      observacoes_cliente TEXT DEFAULT '',
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS itens_pedido (
      id TEXT PRIMARY KEY,
      pedido_id TEXT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      produto_id TEXT NOT NULL REFERENCES produtos(id),
      nome_produto_snapshot TEXT NOT NULL,
      observacao_snapshot TEXT NOT NULL,
      unidade_snapshot TEXT NOT NULL,
      modo_compra TEXT NOT NULL,
      quantidade REAL NOT NULL,
      valor_desejado_centavos INTEGER,
      preco_unitario_snapshot_centavos INTEGER NOT NULL,
      subtotal_centavos INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pagamentos (
      id TEXT PRIMARY KEY,
      pedido_id TEXT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      provedor TEXT NOT NULL,
      external_id TEXT UNIQUE,
      idempotency_key TEXT UNIQUE,
      forma_pagamento TEXT NOT NULL,
      valor_centavos INTEGER NOT NULL,
      parcelas INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (status IN ('PENDENTE', 'APROVADO', 'RECUSADO', 'CANCELADO', 'ESTORNADO')),
      pix_qr_code TEXT,
      pix_qr_code_base64 TEXT,
      payload_bruto TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhooks_processados (
      id TEXT PRIMARY KEY,
      evento_chave TEXT NOT NULL UNIQUE,
      payment_id TEXT,
      processado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS historico_pedidos (
      id TEXT PRIMARY KEY,
      pedido_id TEXT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      tipo_evento TEXT NOT NULL,
      status_anterior TEXT,
      status_novo TEXT NOT NULL,
      descricao TEXT NOT NULL,
      autor_id TEXT,
      autor_papel TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversas (
      id TEXT PRIMARY KEY,
      cliente_id TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      pedido_id TEXT REFERENCES pedidos(id) ON DELETE SET NULL,
      assunto TEXT NOT NULL,
      ultima_mensagem_em TEXT NOT NULL DEFAULT (datetime('now')),
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mensagens (
      id TEXT PRIMARY KEY,
      conversa_id TEXT NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
      remetente_id TEXT NOT NULL,
      remetente_papel TEXT NOT NULL CHECK (remetente_papel IN ('CLIENTE', 'ADMIN')),
      remetente_nome TEXT NOT NULL,
      conteudo TEXT NOT NULL,
      pedido_id TEXT REFERENCES pedidos(id) ON DELETE SET NULL,
      lida INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS configuracoes_loja (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_clientes_cpf ON clientes(cpf);
    CREATE INDEX IF NOT EXISTS idx_enderecos_cliente ON enderecos(cliente_id);
    CREATE INDEX IF NOT EXISTS idx_produtos_categoria ON produtos(categoria_id);
    CREATE INDEX IF NOT EXISTS idx_produtos_situacao ON produtos(situacao);
    CREATE INDEX IF NOT EXISTS idx_produtos_nome_norm ON produtos(nome_normalizado);
    CREATE INDEX IF NOT EXISTS idx_imagens_produto ON imagens_produtos(produto_id);
    CREATE INDEX IF NOT EXISTS idx_itens_carrinho ON itens_carrinho(carrinho_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos(cliente_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_numero ON pedidos(numero_pedido);
    CREATE INDEX IF NOT EXISTS idx_itens_pedido ON itens_pedido(pedido_id);
    CREATE INDEX IF NOT EXISTS idx_pagamentos_pedido ON pagamentos(pedido_id);
    CREATE INDEX IF NOT EXISTS idx_pagamentos_ext ON pagamentos(external_id);
    CREATE INDEX IF NOT EXISTS idx_historico_pedido ON historico_pedidos(pedido_id);
    CREATE INDEX IF NOT EXISTS idx_conversas_cliente ON conversas(cliente_id);
    CREATE INDEX IF NOT EXISTS idx_mensagens_conversa ON mensagens(conversa_id);
  `);

  seedInitialData();
}

function seedInitialData() {
  // 1. Store settings defaults (mandatory shipping R$ 4,99)
  const defaultConfigs: Record<string, string> = {
    frete_padrao_centavos: '499', // R$ 4,99
    max_parcelas: '1',
    parcelas_sem_juros: '1',
    taxa_juros_mensal: '0',
    exibir_esgotados_catalogo: 'true',
    whatsapp_loja: process.env.STORE_WHATSAPP_NUMBER || '5511999999999',
    precisao_pesagem_padrao: '3',
    pix_key: '',
    pix_key_type: 'CPF',
    pix_recipient_name: 'Agro Marconato Agropecuária',
  };

  const upsertCfg = db.prepare(`
    INSERT OR IGNORE INTO configuracoes_loja (chave, valor) VALUES (?, ?)
  `);
  for (const [k, v] of Object.entries(defaultConfigs)) {
    upsertCfg.run(k, v);
  }
  db.prepare(`UPDATE configuracoes_loja SET valor = '499' WHERE chave = 'frete_padrao_centavos'`).run();

  // 2. Ensure main administrator (CPF 11241313962) exists in local SQLite fallback
  const bootCpf = cleanDigits(process.env.ADMIN_BOOTSTRAP_CPF || '11241313962');
  const bootPass = process.env.ADMIN_BOOTSTRAP_SENHA || '03122911#';
  const bootName = process.env.ADMIN_BOOTSTRAP_NOME || 'Administrador Agro Marconato';
  const bootEmail = `${bootCpf}@agromarconato.local`;
  const bootPhone = cleanDigits(process.env.ADMIN_BOOTSTRAP_TELEFONE || '11999990000');
  const existingAdmin = db.prepare(`SELECT id FROM administradores WHERE cpf = ?`).get(bootCpf) as { id: string } | undefined;
  if (!existingAdmin) {
    const hash = bcrypt.hashSync(bootPass, 10);
    db.prepare(`
      INSERT INTO administradores (id, nome_completo, cpf, email, telefone, senha_hash, papel, ativo)
      VALUES (?, ?, ?, ?, ?, ?, 'ADMIN', 1)
    `).run(crypto.randomUUID(), bootName, bootCpf, bootEmail, bootPhone, hash);
    console.info(`[BOOTSTRAP] Administrador principal criado — CPF: ${bootCpf}`);
  }

  // 3. Initial categories
  const catCount = db.prepare(`SELECT COUNT(*) as total FROM categorias`).get() as { total: number };
  if (catCount.total === 0) {
    const categories = [
      { id: 'cat-racoes', nome: 'Rações', slug: 'racoes', descricao: 'Rações para aves, cães, gatos e animais de produção.', ordem: 1 },
      { id: 'cat-vet', nome: 'Produtos Veterinários', slug: 'produtos-veterinarios', descricao: 'Suplementos, vermífugos e cuidados veterinários.', ordem: 2 },
      { id: 'cat-ferramentas', nome: 'Ferramentas', slug: 'ferramentas', descricao: 'Ferramentas manuais e equipamentos de manejo.', ordem: 3 },
      { id: 'cat-sementes', nome: 'Sementes', slug: 'sementes', descricao: 'Sementes selecionadas para pastagem e cultivo.', ordem: 4 },
      { id: 'cat-acessorios', nome: 'Acessórios', slug: 'acessorios', descricao: 'Comedouros, bebedouros e itens para manejo diário.', ordem: 5 },
      { id: 'cat-agro', nome: 'Produtos Agropecuários', slug: 'produtos-agropecuarios', descricao: 'Insumos essenciais para propriedade rural.', ordem: 6 },
    ];
    const insertCat = db.prepare(`
      INSERT INTO categorias (id, nome, slug, descricao, ordem) VALUES (?, ?, ?, ?, ?)
    `);
    for (const c of categories) {
      insertCat.run(c.id, c.nome, c.slug, c.descricao, c.ordem);
    }
  }

  // 4. Initial catalog products (only if empty) using our generated assets
  const prodCount = db.prepare(`SELECT COUNT(*) as total FROM produtos`).get() as { total: number };
  if (prodCount.total === 0) {
    const seedProducts = [
      {
        id: 'prod-racao-calopsita',
        categoria_id: 'cat-racoes',
        nome: 'Ração para Calopsita Premium',
        observacao_curta: 'Mistura especial de sementes para alimentação diária.',
        descricao_completa:
          'Mistura balanceada com painço, alpiste, girassol miúdo, aveia descascada e frutas desidratadas. Ideal para calopsitas, agapórnis e psitacídeos de pequeno porte. Vendida por quilo (kg).',
        palavras_chave: 'racao de passarinho ave calopsita periquito canario papagaio sementes painco',
        preco_centavos: 1800,
        preco_promocional_centavos: null,
        estoque_quantidade: 85.5,
        estoque_baixo_limite: 10,
        unidade_venda: 'KG',
        modalidade_venda: 'PESO_KG',
        precisao_pesagem: 3,
        permite_parcelamento: 0,
        max_parcelas_produto: 1,
        destaque: 1,
        oferta: 0,
        imagem: '/src/assets/images/prod_racao_calopsita_1794877321127.jpg',
      },
      {
        id: 'prod-racao-caes-adultos',
        categoria_id: 'cat-racoes',
        nome: 'Ração Agro Marconato Cães Adultos',
        observacao_curta: 'Alta digestibilidade com 24% de proteína animal.',
        descricao_completa:
          'Alimento completo para cães adultos de médio e grande porte, enriquecido com ômega 3 e 6, prebióticos e minerais quelatados para pelagem saudável e vitalidade no campo ou na cidade.',
        palavras_chave: 'racao cachorro cao caes adulto pet proteina',
        preco_centavos: 1650,
        preco_promocional_centavos: 1490,
        estoque_quantidade: 120.0,
        estoque_baixo_limite: 15,
        unidade_venda: 'KG',
        modalidade_venda: 'PESO_KG',
        precisao_pesagem: 3,
        permite_parcelamento: 0,
        max_parcelas_produto: 1,
        destaque: 1,
        oferta: 1,
        imagem: '/src/assets/images/prod_racao_caes_1794877320362.jpg',
      },
      {
        id: 'prod-racao-canario',
        categoria_id: 'cat-racoes',
        nome: 'Mistura Selecionada para Canário e Periquito',
        observacao_curta: 'Alpiste canadense limpo para aves ornamentais.',
        descricao_completa:
          'Grãos peneirados e ventilados para aves de gaiola como canários, periquitos e mandarins. Auxilia no canto, plumagem e digestão saudável. Compre por peso (kg).',
        palavras_chave: 'racao de passarinho canario periquito passaros alpiste ave',
        preco_centavos: 1500,
        preco_promocional_centavos: null,
        estoque_quantidade: 48.0,
        estoque_baixo_limite: 8,
        unidade_venda: 'KG',
        modalidade_venda: 'PESO_KG',
        precisao_pesagem: 3,
        permite_parcelamento: 0,
        max_parcelas_produto: 1,
        destaque: 0,
        oferta: 0,
        imagem: '/src/assets/images/prod_racao_calopsita_1794877321127.jpg',
      },
      {
        id: 'prod-kit-poda-manejo',
        categoria_id: 'cat-ferramentas',
        nome: 'Kit Tesoura de Poda e Pá Forjada',
        observacao_curta: 'Aço temperado com cabo anatômico para pomar e horta.',
        descricao_completa:
          'Conjunto profissional composto por tesoura de poda com lâmina bypass em aço carbono e pá estreita forjada com cabo em madeira tratada. Alta durabilidade para uso contínuo na propriedade.',
        palavras_chave: 'tesoura poda pa ferramenta jardinagem horta pomar aco',
        preco_centavos: 11900,
        preco_promocional_centavos: 9800,
        estoque_quantidade: 18,
        estoque_baixo_limite: 5,
        unidade_venda: 'UN',
        modalidade_venda: 'UNIDADE',
        precisao_pesagem: 0,
        permite_parcelamento: 0,
        max_parcelas_produto: 1,
        destaque: 1,
        oferta: 1,
        imagem: '/src/assets/images/prod_ferramentas_agro_1794877320622.jpg',
      },
      {
        id: 'prod-sementes-milho',
        categoria_id: 'cat-sementes',
        nome: 'Semente de Milho Híbrido Selecionado',
        observacao_curta: 'Alta taxa de germinação para silagem e grãos.',
        descricao_completa:
          'Sementes de milho tratadas e padronizadas com vigor germinativo superior a 92%. Indicada para plantio de verão, silagem ou alimentação animal direta na propriedade.',
        palavras_chave: 'semente milho grao plantio lavoura silagem passarinho galinha',
        preco_centavos: 1250,
        preco_promocional_centavos: null,
        estoque_quantidade: 200.0,
        estoque_baixo_limite: 25,
        unidade_venda: 'KG',
        modalidade_venda: 'PESO_KG',
        precisao_pesagem: 3,
        permite_parcelamento: 0,
        max_parcelas_produto: 1,
        destaque: 1,
        oferta: 0,
        imagem: '/src/assets/images/prod_sementes_milho_1794877321779.jpg',
      },
      {
        id: 'prod-suplemento-mineral',
        categoria_id: 'cat-vet',
        nome: 'Suplemento Vitamínico Mineral AgroVet',
        observacao_curta: 'Complexo ADE e aminoácidos para recuperação animal.',
        descricao_completa:
          'Suplemento nutricional completo indicado para reforço imunológico, crescimento e recuperação de animais de pequeno e grande porte. Embalagem lacrada de 500 ml com dosador.',
        palavras_chave: 'veterinario suplemento vitamina mineral animal gado cavalo pet',
        preco_centavos: 7490,
        preco_promocional_centavos: 6490,
        estoque_quantidade: 12,
        estoque_baixo_limite: 4,
        unidade_venda: 'UN',
        modalidade_venda: 'UNIDADE',
        precisao_pesagem: 0,
        permite_parcelamento: 0,
        max_parcelas_produto: 1,
        destaque: 1,
        oferta: 1,
        imagem: '/src/assets/images/prod_suplemento_vet_1794877322696.jpg',
      },
    ];

    const insertProd = db.prepare(`
      INSERT INTO produtos (
        id, categoria_id, nome, nome_normalizado, descricao_completa, observacao_curta,
        palavras_chave, palavras_chave_normalizadas, preco_centavos, preco_promocional_centavos,
        estoque_quantidade, estoque_baixo_limite, unidade_venda, modalidade_venda,
        precisao_pesagem, permite_parcelamento, max_parcelas_produto, situacao, destaque, oferta
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISPONIVEL', ?, ?)
    `);

    const insertImg = db.prepare(`
      INSERT INTO imagens_produtos (id, produto_id, url, nome_arquivo, principal, ordem)
      VALUES (?, ?, ?, ?, 1, 0)
    `);

    for (const p of seedProducts) {
      insertProd.run(
        p.id,
        p.categoria_id,
        p.nome,
        normalizeText(p.nome),
        p.descricao_completa,
        p.observacao_curta,
        p.palavras_chave,
        normalizeText(p.palavras_chave),
        p.preco_centavos,
        p.preco_promocional_centavos,
        p.estoque_quantidade,
        p.estoque_baixo_limite,
        p.unidade_venda,
        p.modalidade_venda,
        p.precisao_pesagem,
        p.permite_parcelamento,
        p.max_parcelas_produto,
        p.destaque,
        p.oferta
      );
      insertImg.run(crypto.randomUUID(), p.id, p.imagem, path.basename(p.imagem));
    }
  }

  // Normalize any legacy modalities or installment flags in SQLite
  db.prepare(`
    UPDATE produtos
    SET modalidade_venda = 'PESO_KG', permite_parcelamento = 0, max_parcelas_produto = 1
    WHERE modalidade_venda IN ('PESO_E_VALOR', 'VALOR_DINHEIRO')
  `).run();
  db.prepare(`
    UPDATE produtos
    SET permite_parcelamento = 0, max_parcelas_produto = 1
    WHERE permite_parcelamento != 0 OR max_parcelas_produto != 1
  `).run();
}

export function getStoreConfig(): Record<string, string> {
  const rows = db.prepare(`SELECT chave, valor FROM configuracoes_loja`).all() as { chave: string; valor: string }[];
  const cfg: Record<string, string> = {};
  for (const r of rows) {
    cfg[r.chave] = r.valor;
  }
  return cfg;
}
