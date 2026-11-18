-- ==============================================================================
-- AGRO MARCONATO AGROPECUÁRIA — SCHEMA COMPLETO DE PRODUÇÃO PARA SUPABASE
-- Execute este script completo no SQL Editor do seu projeto Supabase.
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------------------------
-- 1. TABELA DE PERFIS (profiles) VINCULADA AO auth.users
--    Trava UNIQUE(cpf) garantindo estritamente apenas 1 cadastro por CPF.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  cpf VARCHAR(11) NOT NULL UNIQUE,
  full_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_cpf ON public.profiles(cpf);

-- Garante automaticamente is_admin = TRUE para o CPF 80027793950
CREATE OR REPLACE FUNCTION public.enforce_admin_cpf_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cpf TEXT;
BEGIN
  v_cpf := regexp_replace(COALESCE(NEW.cpf, ''), '\D', '', 'g');
  NEW.cpf := v_cpf;
  IF v_cpf = '80027793950' THEN
    NEW.is_admin := TRUE;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_enforce_admin ON public.profiles;
CREATE TRIGGER trg_profiles_enforce_admin
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_admin_cpf_flag();

-- Trigger no auth.users: cria automaticamente o perfil ao cadastrar usuário
-- (inclusive identificando CPF 80027793950 via metadata ou prefixo de ${cpf}@agromarconato.local)
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw_cpf TEXT;
  v_cpf TEXT;
  v_is_admin BOOLEAN := FALSE;
BEGIN
  v_raw_cpf := COALESCE(
    NULLIF(NEW.raw_user_meta_data->>'cpf', ''),
    split_part(COALESCE(NEW.email, ''), '@', 1)
  );
  v_cpf := regexp_replace(v_raw_cpf, '\D', '', 'g');

  IF length(v_cpf) = 11 THEN
    IF v_cpf = '80027793950' THEN
      v_is_admin := TRUE;
    END IF;

    INSERT INTO public.profiles (id, cpf, full_name, phone, email, is_admin)
    VALUES (
      NEW.id,
      v_cpf,
      COALESCE(NULLIF(NEW.raw_user_meta_data->>'full_name', ''), CASE WHEN v_is_admin THEN 'Administrador Agro Marconato' ELSE 'Cliente ' || right(v_cpf, 4) END),
      COALESCE(NEW.raw_user_meta_data->>'phone', ''),
      COALESCE(NEW.email, v_cpf || '@agromarconato.local'),
      v_is_admin
    )
    ON CONFLICT (id) DO UPDATE SET
      cpf = EXCLUDED.cpf,
      is_admin = CASE WHEN EXCLUDED.cpf = '80027793950' THEN TRUE ELSE public.profiles.is_admin END,
      updated_at = NOW();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- Helper seguro para verificar se o usuário autenticado atual é administrador
CREATE OR REPLACE FUNCTION public.is_current_user_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_admin = TRUE
  );
$$;

-- ------------------------------------------------------------------------------
-- 2. CATEGORIAS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.categorias (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  descricao TEXT DEFAULT '',
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 3. PRODUTOS (products) — Venda por Quilo ('kg') ou por Unidade ('un')
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id TEXT REFERENCES public.categorias(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL DEFAULT '',
  short_description TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  keywords_normalized TEXT NOT NULL DEFAULT '',
  unit_type TEXT NOT NULL DEFAULT 'un' CHECK (unit_type IN ('kg', 'un')),
  price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  promo_price NUMERIC(10, 2),
  stock NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (stock >= 0),
  low_stock_limit NUMERIC(12, 3) NOT NULL DEFAULT 5,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  on_sale BOOLEAN NOT NULL DEFAULT FALSE,
  image_url TEXT,
  gallery_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_active ON public.products(active);
CREATE INDEX IF NOT EXISTS idx_products_category ON public.products(category_id);

-- Baixa atômica de estoque (kg fracionado ou unidade inteira)
CREATE OR REPLACE FUNCTION public.decrement_product_stock(
  p_product_id UUID,
  p_quantity NUMERIC
) RETURNS TABLE(new_stock NUMERIC, is_active BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stock NUMERIC;
  v_new NUMERIC;
  v_active BOOLEAN;
BEGIN
  SELECT stock, active INTO v_stock, v_active
  FROM public.products
  WHERE id = p_product_id AND active = TRUE
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produto não encontrado ou inativo.';
  END IF;

  IF v_stock < p_quantity THEN
    RAISE EXCEPTION 'Estoque insuficiente. Disponível: %', v_stock;
  END IF;

  v_new := ROUND((v_stock - p_quantity)::numeric, 3);
  IF v_new < 0 THEN
    v_new := 0;
  END IF;

  UPDATE public.products
  SET stock = v_new,
      updated_at = NOW()
  WHERE id = p_product_id;

  RETURN QUERY SELECT v_new, v_active;
END;
$$;

-- ------------------------------------------------------------------------------
-- 4. CONFIGURAÇÕES DA LOJA E CHAVE PIX DO ADMINISTRADOR (admin_settings)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pix_key TEXT NOT NULL DEFAULT '',
  pix_key_type TEXT NOT NULL DEFAULT 'CPF' CHECK (pix_key_type IN ('CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'EVP')),
  pix_recipient_name TEXT NOT NULL DEFAULT 'Agro Marconato Agropecuária',
  shipping_fee NUMERIC(10, 2) NOT NULL DEFAULT 4.99,
  whatsapp_loja TEXT NOT NULL DEFAULT '5511999999999',
  exibir_esgotados_catalogo BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 5. PEDIDOS EM TEMPO REAL (orders) — Frete Fixo Obrigatório R$ 4,99
-- ------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.orders_number_seq START 1001;

CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number INTEGER NOT NULL UNIQUE DEFAULT nextval('public.orders_number_seq'),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  cliente_cpf VARCHAR(11) NOT NULL,
  cliente_nome TEXT NOT NULL DEFAULT '',
  cliente_telefone TEXT NOT NULL DEFAULT '',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal NUMERIC(10, 2) NOT NULL CHECK (subtotal >= 0),
  shipping_fee NUMERIC(10, 2) NOT NULL DEFAULT 4.99 CHECK (shipping_fee = 4.99),
  total_amount NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 4.99),
  payment_method TEXT NOT NULL DEFAULT 'pix' CHECK (payment_method IN ('pix', 'credit_card', 'cash_on_delivery')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'refunded')),
  delivery_status TEXT NOT NULL DEFAULT 'CONFIRMADO' CHECK (delivery_status IN ('CONFIRMADO', 'EM_PREPARACAO', 'SAIU_PARA_ENTREGA', 'ENTREGUE', 'CANCELADO')),
  shipping_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT DEFAULT '',
  payment_id TEXT,
  external_reference TEXT UNIQUE,
  pix_key_used TEXT,
  pix_key_type TEXT,
  pix_qr_code TEXT,
  pix_qr_code_base64 TEXT,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON public.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_ext_ref ON public.orders(external_reference);

-- ------------------------------------------------------------------------------
-- 6. CARRINHO PERSISTENTE, ENDEREÇOS, CHAT E DEDUPLICAÇÃO DE WEBHOOKS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.carrinhos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.itens_carrinho (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carrinho_id UUID NOT NULL REFERENCES public.carrinhos(id) ON DELETE CASCADE,
  produto_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  modo_compra TEXT NOT NULL CHECK (modo_compra IN ('UNIDADE', 'PESO_KG')),
  quantidade NUMERIC(12, 3) NOT NULL CHECK (quantidade > 0),
  preco_unitario_snapshot_centavos INTEGER NOT NULL,
  subtotal_centavos INTEGER NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.enderecos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS public.conversas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  pedido_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  assunto TEXT NOT NULL,
  ultima_mensagem_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.mensagens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id UUID NOT NULL REFERENCES public.conversas(id) ON DELETE CASCADE,
  remetente_id TEXT NOT NULL,
  remetente_papel TEXT NOT NULL CHECK (remetente_papel IN ('CLIENTE', 'ADMIN')),
  remetente_nome TEXT NOT NULL,
  conteudo TEXT NOT NULL,
  pedido_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  lida BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.webhooks_processados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_chave TEXT NOT NULL UNIQUE,
  payment_id TEXT,
  processado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.tentativas_login (
  id BIGSERIAL PRIMARY KEY,
  chave TEXT NOT NULL UNIQUE,
  tentativas INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate TIMESTAMPTZ,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY (RLS) + POLÍTICAS COMPLETAS
-- ------------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carrinhos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.itens_carrinho ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enderecos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mensagens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhooks_processados ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tentativas_login ENABLE ROW LEVEL SECURITY;

-- PROFILES
DROP POLICY IF EXISTS "profiles_select_own_or_admin" ON public.profiles;
CREATE POLICY "profiles_select_own_or_admin" ON public.profiles
  FOR SELECT USING (auth.uid() = id OR public.is_current_user_admin());

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own_or_admin" ON public.profiles;
CREATE POLICY "profiles_update_own_or_admin" ON public.profiles
  FOR UPDATE USING (auth.uid() = id OR public.is_current_user_admin());

-- CATEGORIAS (qualquer visitante lê; apenas admin altera)
DROP POLICY IF EXISTS "categorias_public_read" ON public.categorias;
CREATE POLICY "categorias_public_read" ON public.categorias
  FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "categorias_admin_write" ON public.categorias;
CREATE POLICY "categorias_admin_write" ON public.categorias
  FOR ALL USING (public.is_current_user_admin()) WITH CHECK (public.is_current_user_admin());

-- PRODUCTS (qualquer visitante lê catálogo ativo; apenas admin gerencia)
DROP POLICY IF EXISTS "products_public_read_active" ON public.products;
CREATE POLICY "products_public_read_active" ON public.products
  FOR SELECT USING (active = TRUE OR public.is_current_user_admin());

DROP POLICY IF EXISTS "products_admin_insert" ON public.products;
CREATE POLICY "products_admin_insert" ON public.products
  FOR INSERT WITH CHECK (public.is_current_user_admin());

DROP POLICY IF EXISTS "products_admin_update" ON public.products;
CREATE POLICY "products_admin_update" ON public.products
  FOR UPDATE USING (public.is_current_user_admin()) WITH CHECK (public.is_current_user_admin());

DROP POLICY IF EXISTS "products_admin_delete" ON public.products;
CREATE POLICY "products_admin_delete" ON public.products
  FOR DELETE USING (public.is_current_user_admin());

-- ORDERS (usuário vê/cria seus próprios pedidos; admin vê e gerencia todos)
DROP POLICY IF EXISTS "orders_select_own_or_admin" ON public.orders;
CREATE POLICY "orders_select_own_or_admin" ON public.orders
  FOR SELECT USING (auth.uid() = user_id OR public.is_current_user_admin());

DROP POLICY IF EXISTS "orders_insert_own" ON public.orders;
CREATE POLICY "orders_insert_own" ON public.orders
  FOR INSERT WITH CHECK (auth.uid() = user_id AND shipping_fee = 4.99);

DROP POLICY IF EXISTS "orders_update_admin" ON public.orders;
CREATE POLICY "orders_update_admin" ON public.orders
  FOR UPDATE USING (public.is_current_user_admin()) WITH CHECK (public.is_current_user_admin());

-- ADMIN_SETTINGS (apenas admin lê e edita no client; backend usa service_role)
DROP POLICY IF EXISTS "admin_settings_admin_only" ON public.admin_settings;
CREATE POLICY "admin_settings_admin_only" ON public.admin_settings
  FOR ALL USING (public.is_current_user_admin()) WITH CHECK (public.is_current_user_admin());

-- CARRINHOS / ENDEREÇOS / CONVERSAS
DROP POLICY IF EXISTS "carrinhos_own_access" ON public.carrinhos;
CREATE POLICY "carrinhos_own_access" ON public.carrinhos
  FOR ALL USING (auth.uid() = cliente_id) WITH CHECK (auth.uid() = cliente_id);

DROP POLICY IF EXISTS "itens_carrinho_own_access" ON public.itens_carrinho;
CREATE POLICY "itens_carrinho_own_access" ON public.itens_carrinho
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.carrinhos c WHERE c.id = carrinho_id AND c.cliente_id = auth.uid())
  );

DROP POLICY IF EXISTS "enderecos_own_access" ON public.enderecos;
CREATE POLICY "enderecos_own_access" ON public.enderecos
  FOR ALL USING (auth.uid() = cliente_id) WITH CHECK (auth.uid() = cliente_id);

DROP POLICY IF EXISTS "conversas_own_or_admin" ON public.conversas;
CREATE POLICY "conversas_own_or_admin" ON public.conversas
  FOR ALL USING (auth.uid() = cliente_id OR public.is_current_user_admin());

DROP POLICY IF EXISTS "mensagens_own_or_admin" ON public.mensagens;
CREATE POLICY "mensagens_own_or_admin" ON public.mensagens
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.conversas cv
      WHERE cv.id = conversa_id AND (cv.cliente_id = auth.uid() OR public.is_current_user_admin())
    )
  );

-- ------------------------------------------------------------------------------
-- 8. REALTIME & STORAGE BUCKET
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'products'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.products;
  END IF;
END $$;

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
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Admin gerencia imagens produtos'
  ) THEN
    CREATE POLICY "Admin gerencia imagens produtos"
      ON storage.objects FOR ALL
      USING (bucket_id = 'produtos' AND public.is_current_user_admin())
      WITH CHECK (bucket_id = 'produtos' AND public.is_current_user_admin());
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 9. DADOS INICIAIS ESSENCIAIS (Categorias e Configurações Padrão)
-- ------------------------------------------------------------------------------
INSERT INTO public.categorias (id, nome, slug, descricao, ordem) VALUES
  ('cat-racoes', 'Rações', 'racoes', 'Rações para aves, cães, gatos e animais de produção.', 1),
  ('cat-vet', 'Produtos Veterinários', 'produtos-veterinarios', 'Suplementos, vermífugos e cuidados veterinários.', 2),
  ('cat-ferramentas', 'Ferramentas', 'ferramentas', 'Ferramentas manuais e equipamentos de manejo.', 3),
  ('cat-sementes', 'Sementes', 'sementes', 'Sementes selecionadas para pastagem e cultivo.', 4),
  ('cat-acessorios', 'Acessórios', 'acessorios', 'Comedouros, bebedouros e itens para manejo diário.', 5),
  ('cat-agro', 'Produtos Agropecuários', 'produtos-agropecuarios', 'Insumos essenciais para propriedade rural.', 6)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.admin_settings (id, pix_key, pix_key_type, pix_recipient_name, shipping_fee, whatsapp_loja, exibir_esgotados_catalogo)
VALUES (1, '', 'CPF', 'Agro Marconato Agropecuária', 4.99, '5511999999999', TRUE)
ON CONFLICT (id) DO NOTHING;
