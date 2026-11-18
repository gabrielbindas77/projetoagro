export type UserRole = 'CLIENTE' | 'ADMIN';

export interface User {
  id: string;
  nome_completo: string;
  cpf: string;
  email: string;
  telefone: string;
  papel: UserRole;
  is_admin: boolean;
  email_verificado?: boolean;
  telefone_verificado?: boolean;
  identidade_verificada?: boolean;
}

export type PixKeyType = 'CPF' | 'CNPJ' | 'EMAIL' | 'TELEFONE' | 'EVP';

export interface PublicConfig {
  frete_padrao_centavos: number;
  max_parcelas: number;
  parcelas_sem_juros: number;
  taxa_juros_mensal: number;
  exibir_esgotados_catalogo: boolean;
  whatsapp_loja: string;
  precisao_pesagem_padrao: number;
  pix_key_configurada?: boolean;
  pix_key_type?: PixKeyType;
  mercado_pago_public_key: string;
  mercado_pago_configurado: boolean;
  database_engine?: 'supabase' | 'sqlite-local';
  supabase_url?: string;
}

export interface AdminPixSettings {
  pix_key: string;
  pix_key_type: PixKeyType;
  pix_recipient_name: string;
  shipping_fee: number;
}

export interface Category {
  id: string;
  nome: string;
  slug: string;
  descricao: string;
  ordem: number;
}

export interface ProductImage {
  id: string;
  produto_id: string;
  url: string;
  nome_arquivo: string | null;
  principal: number;
  ordem: number;
}

export type UnitType = 'kg' | 'un';
export type ModalidadeVenda = 'UNIDADE' | 'PESO_KG';
export type ModoCompra = 'UNIDADE' | 'PESO_KG';

export interface Product {
  id: string;
  categoria_id: string;
  categoria_nome?: string;
  categoria_slug?: string;
  nome: string;
  descricao_completa: string;
  observacao_curta: string;
  palavras_chave: string;
  unit_type: UnitType;
  preco_centavos: number;
  preco_promocional_centavos: number | null;
  preco_vigente_centavos: number;
  estoque_quantidade: number;
  estoque_baixo_limite: number;
  unidade_venda: string;
  modalidade_venda: ModalidadeVenda;
  precisao_pesagem: number;
  permite_parcelamento: number;
  max_parcelas_produto: number;
  situacao: 'DISPONIVEL' | 'ESGOTADO' | 'INATIVO';
  destaque: number;
  oferta: number;
  imagem_principal: string | null;
  imagens: ProductImage[];
}

export interface CartItem {
  id: string;
  carrinho_id: string;
  produto_id: string;
  produto_nome: string;
  observacao_curta: string;
  unit_type: UnitType;
  unidade_venda: string;
  modalidade_venda: ModalidadeVenda;
  precisao_pesagem: number;
  estoque_quantidade: number;
  situacao: 'DISPONIVEL' | 'ESGOTADO' | 'INATIVO';
  modo_compra: ModoCompra;
  quantidade: number;
  valor_desejado_centavos: number | null;
  preco_unitario_snapshot_centavos: number;
  subtotal_centavos: number;
  imagem_principal: string | null;
  max_parcelas_produto: number;
}

export interface CartState {
  carrinho_id: string | null;
  itens: CartItem[];
  subtotal_centavos: number;
  frete_centavos: number;
  total_centavos: number;
}

export interface Address {
  id?: string;
  nome_destinatario?: string;
  telefone_contato?: string;
  email_comprovante?: string;
  cep: string;
  rua: string;
  numero: string;
  complemento?: string;
  bairro: string;
  cidade: string;
  estado: string;
}

export interface OrderItem {
  id: string;
  pedido_id: string;
  produto_id: string;
  nome_produto_snapshot: string;
  observacao_snapshot: string;
  unidade_snapshot: string;
  unit_type?: UnitType;
  modo_compra: ModoCompra;
  quantidade: number;
  valor_desejado_centavos: number | null;
  preco_unitario_snapshot_centavos: number;
  subtotal_centavos: number;
}

export interface PaymentRecord {
  id: string;
  pedido_id: string;
  provedor: string;
  external_id: string | null;
  forma_pagamento: 'PIX' | 'CARTAO_CREDITO' | 'DINHEIRO_NA_ENTREGA';
  valor_centavos: number;
  parcelas: number;
  status: 'PENDENTE' | 'APROVADO' | 'RECUSADO' | 'CANCELADO' | 'ESTORNADO';
  pix_qr_code: string | null;
  pix_qr_code_base64: string | null;
  criado_em: string;
  atualizado_em: string;
}

export interface OrderHistory {
  id: string;
  pedido_id: string;
  tipo_evento: string;
  status_anterior: string | null;
  status_novo: string;
  descricao: string;
  autor_papel: string | null;
  criado_em: string;
}

export interface Order {
  id: string;
  numero_pedido: number;
  cliente_id: string;
  cliente_nome?: string;
  cliente_cpf?: string;
  cliente_telefone?: string;
  cliente_email?: string;
  endereco_cep: string;
  endereco_rua: string;
  endereco_numero: string;
  endereco_complemento: string;
  endereco_bairro: string;
  endereco_cidade: string;
  endereco_estado: string;
  subtotal_centavos: number;
  frete_centavos: number;
  total_centavos: number;
  forma_pagamento: 'PIX' | 'CARTAO_CREDITO' | 'DINHEIRO_NA_ENTREGA';
  parcelas: number;
  situacao_financeira: 'AGUARDANDO_PAGAMENTO' | 'PAGO' | 'RECUSADO' | 'CANCELADO' | 'ESTORNADO';
  situacao_entrega: 'CONFIRMADO' | 'EM_PREPARACAO' | 'SAIU_PARA_ENTREGA' | 'ENTREGUE' | 'CANCELADO';
  observacoes_cliente: string;
  criado_em: string;
  atualizado_em: string;
  itens: OrderItem[];
  pagamentos: PaymentRecord[];
  historico: OrderHistory[];
}

export interface Conversation {
  id: string;
  cliente_id: string;
  pedido_id: string | null;
  assunto: string;
  ultima_mensagem_em: string;
  criado_em: string;
  cliente_nome?: string;
  cliente_cpf?: string;
  cliente_telefone?: string;
  nao_lidas?: number;
  ultima_mensagem?: string | null;
}

export interface ChatMessage {
  id: string;
  conversa_id: string;
  remetente_id: string;
  remetente_papel: UserRole;
  remetente_nome: string;
  conteudo: string;
  pedido_id: string | null;
  lida: number;
  criado_em: string;
}

export interface AdminDashboard {
  total_vendas_centavos: number;
  quantidade_pedidos: number;
  pedidos_aguardando_pagamento: number;
  pedidos_em_preparacao: number;
  pedidos_enviados: number;
  pedidos_entregues: number;
  produtos_estoque_baixo: Array<{
    id: string;
    nome: string;
    estoque_quantidade: number;
    estoque_baixo_limite: number;
    unidade_venda: string;
    situacao: string;
  }>;
  produtos_esgotados: Array<{
    id: string;
    nome: string;
    estoque_quantidade: number;
    unidade_venda: string;
    situacao: string;
  }>;
}
