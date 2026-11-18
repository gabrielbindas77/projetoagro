-- ==============================================================================
-- AGRO MARCONATO AGROPECUÁRIA — SCHEMA COMPLETO PARA SUPABASE (POSTGRESQL)
-- Execute este script no SQL Editor do seu projeto Supabase.
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. CLIENTES
CREATE TABLE IF NOT EXISTS public.clientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_completo TEXT NOT NULL,
  cpf VARCHAR(11) NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  telefone VARCHAR(15) NOT NULL,
  senha_hash TEXT NOT NULL,
  email_verificado BOOLEAN NOT NULL DEFAULT FALSE,
  telefone_verificado BOOLEAN NOT NULL DEFAULT FALSE,
  identidade_verificada BOOLEAN NOT NULL DEFAULT FALSE,
  papel TEXT NOT NULL DEFAULT 'CLIENTE' CHECK (papel = 'CLIENTE'),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. ADMINISTRADORES
CREATE TABLE IF NOT EXISTS public.administradores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_completo TEXT NOT NULL,
  cpf VARCHAR(11) NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  telefone VARCHAR(15) NOT NULL,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL DEFAULT 'ADMIN' CHECK (papel = 'ADMIN'),
  criado_por UUID REFERENCES public.administradores(id) ON DELETE SET NULL,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. CÓDIGOS DE VERIFICAÇÃO (E-mail, Telefone e Recuperação de Senha)
CREATE TABLE IF NOT EXISTS public.codigos_verificacao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alvo TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('EMAIL', 'TELEFONE', 'RECUPERACAO_SENHA')),
  codigo_hash TEXT NOT NULL,
  expira_em TIMESTAMPTZ NOT NULL,
  usado BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. CONTROLE DE TENTATIVAS DE LOGIN (Rate Limiting)
CREATE TABLE IF NOT EXISTS public.tentativas_login (
  id BIGSERIAL PRIMARY KEY,
  chave TEXT NOT NULL UNIQUE,
  tentativas INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate TIMESTAMPTZ,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. ENDEREÇOS DE ENTREGA
CREATE TABLE IF NOT EXISTS public.enderecos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  cep VARCHAR(8) NOT NULL,
  rua TEXT NOT NULL,
  numero TEXT NOT NULL,
  complemento TEXT DEFAULT '',
  bairro TEXT NOT NULL,
  cidade TEXT NOT NULL,
  estado VARCHAR(2) NOT NULL,
  padrao BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. CATEGORIAS
CREATE TABLE IF NOT EXISTS public.categorias (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  descricao TEXT DEFAULT '',
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. PRODUTOS
CREATE TABLE IF NOT EXISTS public.produtos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  categoria_id TEXT NOT NULL REFERENCES public.categorias(id) ON DELETE RESTRICT,
  nome TEXT NOT NULL,
  nome_normalizado TEXT NOT NULL,
  descricao_completa TEXT NOT NULL,
  observacao_curta TEXT NOT NULL,
  palavras_chave TEXT NOT NULL DEFAULT '',
  palavras_chave_normalizadas TEXT NOT NULL DEFAULT '',
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
  preco_promocional_centavos INTEGER,
  estoque_quantidade NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (estoque_quantidade >= 0),
  estoque_baixo_limite NUMERIC(12, 3) NOT NULL DEFAULT 5,
  unidade_venda TEXT NOT NULL DEFAULT 'UN',
  modalidade_venda TEXT NOT NULL CHECK (modalidade_venda IN ('UNIDADE', 'PESO_KG', 'VALOR_DINHEIRO', 'PESO_E_VALOR')),
  precisao_pesagem INTEGER NOT NULL DEFAULT 3,
  permite_parcelamento BOOLEAN NOT NULL DEFAULT FALSE,
  max_parcelas_produto INTEGER NOT NULL DEFAULT 1,
  situacao TEXT NOT NULL DEFAULT 'DISPONIVEL' CHECK (situacao IN ('DISPONIVEL', 'ESGOTADO', 'INATIVO')),
  destaque BOOLEAN NOT NULL DEFAULT FALSE,
  oferta BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. IMAGENS DOS PRODUTOS
CREATE TABLE IF NOT EXISTS public.imagens_produtos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id UUID NOT NULL REFERENCES public.produtos(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  nome_arquivo TEXT,
  principal BOOLEAN NOT NULL DEFAULT FALSE,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. CARRINHOS PERSISTENTES
CREATE TABLE IF NOT EXISTS public.carrinhos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL UNIQUE REFERENCES public.clientes(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. ITENS DO CARRINHO
CREATE TABLE IF NOT EXISTS public.itens_carrinho (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carrinho_id UUID NOT NULL REFERENCES public.carrinhos(id) ON DELETE CASCADE,
  produto_id UUID NOT NULL REFERENCES public.produtos(id) ON DELETE CASCADE,
  modo_compra TEXT NOT NULL CHECK (modo_compra IN ('UNIDADE', 'PESO_KG', 'VALOR_DINHEIRO')),
  quantidade NUMERIC(12, 3) NOT NULL CHECK (quantidade > 0),
  valor_desejado_centavos INTEGER,
  preco_unitario_snapshot_centavos INTEGER NOT NULL,
  subtotal_centavos INTEGER NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. PEDIDOS
CREATE SEQUENCE IF NOT EXISTS public.pedidos_numero_seq START 1001;

CREATE TABLE IF NOT EXISTS public.pedidos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_pedido INTEGER NOT NULL UNIQUE DEFAULT nextval('public.pedidos_numero_seq'),
  cliente_id UUID NOT NULL REFERENCES public.clientes(id) ON DELETE RESTRICT,
  endereco_cep VARCHAR(8) NOT NULL,
  endereco_rua TEXT NOT NULL,
  endereco_numero TEXT NOT NULL,
  endereco_complemento TEXT DEFAULT '',
  endereco_bairro TEXT NOT NULL,
  endereco_cidade TEXT NOT NULL,
  endereco_estado VARCHAR(2) NOT NULL,
  subtotal_centavos INTEGER NOT NULL,
  frete_centavos INTEGER NOT NULL,
  total_centavos INTEGER NOT NULL,
  forma_pagamento TEXT NOT NULL CHECK (forma_pagamento IN ('PIX', 'CARTAO_CREDITO', 'DINHEIRO_NA_ENTREGA')),
  parcelas INTEGER NOT NULL DEFAULT 1,
  situacao_financeira TEXT NOT NULL CHECK (situacao_financeira IN ('AGUARDANDO_PAGAMENTO', 'PAGO', 'RECUSADO', 'CANCELADO', 'ESTORNADO')),
  situacao_entrega TEXT NOT NULL CHECK (situacao_entrega IN ('CONFIRMADO', 'EM_PREPARACAO', 'SAIU_PARA_ENTREGA', 'ENTREGUE', 'CANCELADO')),
  observacoes_cliente TEXT DEFAULT '',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. ITENS DO PEDIDO (Snapshot imutável de preços e descrições)
CREATE TABLE IF NOT EXISTS public.itens_pedido (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id UUID NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  produto_id UUID NOT NULL REFERENCES public.produtos(id) ON DELETE RESTRICT,
  nome_produto_snapshot TEXT NOT NULL,
  observacao_snapshot TEXT NOT NULL,
  unidade_snapshot TEXT NOT NULL,
  modo_compra TEXT NOT NULL,
  quantidade NUMERIC(12, 3) NOT NULL,
  valor_desejado_centavos INTEGER,
  preco_unitario_snapshot_centavos INTEGER NOT NULL,
  subtotal_centavos INTEGER NOT NULL
);

-- 13. PAGAMENTOS
CREATE TABLE IF NOT EXISTS public.pagamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id UUID NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  provedor TEXT NOT NULL,
  external_id TEXT UNIQUE,
  idempotency_key TEXT UNIQUE,
  forma_pagamento TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL,
  parcelas INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('PENDENTE', 'APROVADO', 'RECUSADO', 'CANCELADO', 'ESTORNADO')),
  pix_qr_code TEXT,
  pix_qr_code_base64 TEXT,
  payload_bruto JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 14. PROTEÇÃO CONTRA WEBHOOK DUPLICADO
CREATE TABLE IF NOT EXISTS public.webhooks_processados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_chave TEXT NOT NULL UNIQUE,
  payment_id TEXT,
  processado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 15. HISTÓRICO DE ALTERAÇÕES DO PEDIDO
CREATE TABLE IF NOT EXISTS public.historico_pedidos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id UUID NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  tipo_evento TEXT NOT NULL,
  status_anterior TEXT,
  status_novo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  autor_id TEXT,
  autor_papel TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 16. CONVERSAS DE ATENDIMENTO
CREATE TABLE IF NOT EXISTS public.conversas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  pedido_id UUID REFERENCES public.pedidos(id) ON DELETE SET NULL,
  assunto TEXT NOT NULL,
  ultima_mensagem_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 17. MENSAGENS DO CHAT
CREATE TABLE IF NOT EXISTS public.mensagens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id UUID NOT NULL REFERENCES public.conversas(id) ON DELETE CASCADE,
  remetente_id TEXT NOT NULL,
  remetente_papel TEXT NOT NULL CHECK (remetente_papel IN ('CLIENTE', 'ADMIN')),
  remetente_nome TEXT NOT NULL,
  conteudo TEXT NOT NULL,
  pedido_id UUID REFERENCES public.pedidos(id) ON DELETE SET NULL,
  lida BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 18. CONFIGURAÇÕES DA LOJA
CREATE TABLE IF NOT EXISTS public.configuracoes_loja (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ÍNDICES DE PERFORMANCE
CREATE INDEX IF NOT EXISTS idx_clientes_cpf ON public.clientes(cpf);
CREATE INDEX IF NOT EXISTS idx_enderecos_cliente ON public.enderecos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_produtos_categoria ON public.produtos(categoria_id);
CREATE INDEX IF NOT EXISTS idx_produtos_situacao ON public.produtos(situacao);
CREATE INDEX IF NOT EXISTS idx_produtos_nome_norm ON public.produtos(nome_normalizado);
CREATE INDEX IF NOT EXISTS idx_imagens_produto ON public.imagens_produtos(produto_id);
CREATE INDEX IF NOT EXISTS idx_itens_carrinho ON public.itens_carrinho(carrinho_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON public.pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_numero ON public.pedidos(numero_pedido);
CREATE INDEX IF NOT EXISTS idx_itens_pedido ON public.itens_pedido(pedido_id);
CREATE INDEX IF NOT EXISTS idx_pagamentos_pedido ON public.pagamentos(pedido_id);
CREATE INDEX IF NOT EXISTS idx_historico_pedido ON public.historico_pedidos(pedido_id);
CREATE INDEX IF NOT EXISTS idx_conversas_cliente ON public.conversas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_mensagens_conversa ON public.mensagens(conversa_id);

-- FUNÇÃO ATÔMICA DE BAIXA DE ESTOQUE (previne venda acima do estoque em acessos simultâneos)
CREATE OR REPLACE FUNCTION public.decrementar_estoque_produto(
  p_produto_id UUID,
  p_quantidade NUMERIC
) RETURNS TABLE(novo_estoque NUMERIC, nova_situacao TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_estoque_atual NUMERIC;
  v_novo NUMERIC;
  v_sit TEXT;
BEGIN
  SELECT estoque_quantidade INTO v_estoque_atual
  FROM public.produtos
  WHERE id = p_produto_id AND situacao = 'DISPONIVEL'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produto indisponível para venda.';
  END IF;

  IF v_estoque_atual < p_quantidade THEN
    RAISE EXCEPTION 'Estoque insuficiente. Disponível: %', v_estoque_atual;
  END IF;

  v_novo := ROUND((v_estoque_atual - p_quantidade)::numeric, 3);
  IF v_novo <= 0 THEN
    v_novo := 0;
    v_sit := 'ESGOTADO';
  ELSE
    v_sit := 'DISPONIVEL';
  END IF;

  UPDATE public.produtos
  SET estoque_quantidade = v_novo,
      situacao = v_sit,
      atualizado_em = NOW()
  WHERE id = p_produto_id;

  RETURN QUERY SELECT v_novo, v_sit;
END;
$$;

-- SEGURANÇA: ATIVAR ROW LEVEL SECURITY EM TODAS AS TABELAS
-- (O backend Express autenticado usa SUPABASE_SECRET_KEY com acesso administrativo seguro,
--  bloqueando qualquer acesso anônimo direto do navegador às tabelas sensíveis.)
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.administradores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.codigos_verificacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tentativas_login ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enderecos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imagens_produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carrinhos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.itens_carrinho ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.itens_pedido ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhooks_processados ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historico_pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mensagens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.configuracoes_loja ENABLE ROW LEVEL SECURITY;

-- BUCKET DE STORAGE PARA FOTOS REAIS DOS PRODUTOS
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'produtos',
  'produtos',
  TRUE,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = TRUE,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Leitura publica imagens produtos'
  ) THEN
    CREATE POLICY "Leitura publica imagens produtos"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'produtos');
  END IF;
END $$;

-- 19. CONFIGURAÇÕES DE RECEBIMENTO PIX DO ADMINISTRADOR (admin_settings)
CREATE TABLE IF NOT EXISTS public.admin_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pix_key TEXT NOT NULL DEFAULT '',
  pix_key_type TEXT NOT NULL DEFAULT 'CPF' CHECK (pix_key_type IN ('CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'EVP')),
  pix_recipient_name TEXT NOT NULL DEFAULT 'Agro Marconato Agropecuária',
  shipping_fee NUMERIC(10, 2) NOT NULL DEFAULT 4.99,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20. TABELA DE PEDIDOS SIMPLIFICADA PARA CHECKOUT/WEBHOOK REALTIME (orders)
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id UUID REFERENCES public.pedidos(id) ON DELETE CASCADE,
  cliente_id UUID REFERENCES public.clientes(id) ON DELETE RESTRICT,
  subtotal NUMERIC(10, 2) NOT NULL,
  shipping_fee NUMERIC(10, 2) NOT NULL DEFAULT 4.99,
  total NUMERIC(10, 2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'refunded')),
  payment_method TEXT NOT NULL DEFAULT 'pix',
  payment_id TEXT,
  external_reference TEXT UNIQUE,
  pix_key_used TEXT,
  pix_key_type TEXT,
  pix_qr_code TEXT,
  pix_qr_code_base64 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_ext_ref ON public.orders(external_reference);

ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- HABILITAR SUPABASE REALTIME PARA ATUALIZAÇÃO AUTOMÁTICA NO PAINEL ADMIN
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'pedidos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pedidos;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
  END IF;
END $$;

-- DADOS INICIAIS: CATEGORIAS E CONFIGURAÇÕES PADRÃO DA LOJA
INSERT INTO public.categorias (id, nome, slug, descricao, ordem) VALUES
  ('cat-racoes', 'Rações', 'racoes', 'Rações para aves, cães, gatos e animais de produção.', 1),
  ('cat-vet', 'Produtos Veterinários', 'produtos-veterinarios', 'Suplementos, vermífugos e cuidados veterinários.', 2),
  ('cat-ferramentas', 'Ferramentas', 'ferramentas', 'Ferramentas manuais e equipamentos de manejo.', 3),
  ('cat-sementes', 'Sementes', 'sementes', 'Sementes selecionadas para pastagem e cultivo.', 4),
  ('cat-acessorios', 'Acessórios', 'acessorios', 'Comedouros, bebedouros e itens para manejo diário.', 5),
  ('cat-agro', 'Produtos Agropecuários', 'produtos-agropecuarios', 'Insumos essenciais para propriedade rural.', 6)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.configuracoes_loja (chave, valor) VALUES
  ('frete_padrao_centavos', '499'),
  ('max_parcelas', '1'),
  ('parcelas_sem_juros', '1'),
  ('taxa_juros_mensal', '0'),
  ('exibir_esgotados_catalogo', 'true'),
  ('whatsapp_loja', '5511999999999'),
  ('precisao_pesagem_padrao', '3'),
  ('pix_key', ''),
  ('pix_key_type', 'CPF'),
  ('pix_recipient_name', 'Agro Marconato Agropecuária')
ON CONFLICT (chave) DO NOTHING;

INSERT INTO public.admin_settings (id, pix_key, pix_key_type, pix_recipient_name, shipping_fee)
VALUES (1, '', 'CPF', 'Agro Marconato Agropecuária', 4.99)
ON CONFLICT (id) DO NOTHING;
