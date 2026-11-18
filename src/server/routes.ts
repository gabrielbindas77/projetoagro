import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import {
  clearSessionCookie,
  optionalAuth,
  requireAdmin,
  requireAuth,
  requireCliente,
  setSessionCookie,
  signSessionToken,
  type AuthRequest,
} from './auth.ts';
import { uploadsDir } from './db.ts';
import {
  authenticateUserByCpfPassword,
  checkRateLimit,
  clearFailedAttempts,
  createCategoria,
  createProduto,
  deleteOrInactivateProduto,
  deleteProductImage,
  getCartPayload,
  getConfigMap,
  getProdutoById,
  getStorageModeInfo,
  getUserProfileById,
  listCategorias,
  listProdutos,
  recordFailedAttempt,
  registerUserByCpfPassword,
  setPrimaryProductImage,
  updateConfigMap,
  updateProduto,
  updateProfileContactInfo,
  uploadProductImages,
} from './store-repo.ts';
import {
  addConversationMessageRepo,
  addOrMergeCartItem,
  applyPaymentStatusRepo,
  createEndereco,
  createOrderFromCartRepo,
  getAdminDashboardRepo,
  getConversationMessagesRepo,
  getOrCreateConversationRepo,
  getOrderByIdRepo,
  isWebhookProcessedRepo,
  listAdminsRepo,
  listClientesAdminRepo,
  listConversationsRepo,
  listEnderecosByCliente,
  listOrdersRepo,
  markWebhookProcessedRepo,
  removeCartItemRepo,
  saveOrderPaymentRepo,
  settleCashOrderRepo,
  updateCartItemRepo,
  updateOrderDeliveryStatusRepo,
  createAdminRepo,
} from './store-repo-orders.ts';
import {
  cleanDigits,
  isValidBrazilPhone,
  isValidCPF,
  isValidEmail,
  normalizeText,
  validatePasswordStrength,
  verifyMercadoPagoWebhookSignature,
} from './utils.ts';
import { broadcastChatMessage, broadcastOrderUpdate } from './ws.ts';

export const apiRouter = express.Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    } catch {
      // ignore
    }
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Formato inválido. Envie apenas imagens JPG, PNG ou WEBP.'));
    }
    cb(null, true);
  },
});

function computeCartItemValues(
  produto: any,
  modoCompra: string,
  quantidadeInput?: number
) {
  const precoUnitario = Number(produto.preco_vigente_centavos ?? produto.preco_centavos);
  const precisao = Number(produto.precisao_pesagem ?? 3);

  if (modoCompra === 'UNIDADE') {
    const qtd = Math.floor(Number(quantidadeInput || 0));
    if (qtd < 1) throw new Error('Quantidade mínima é 1 unidade.');
    if (qtd > Number(produto.estoque_quantidade)) {
      throw new Error(`Estoque insuficiente. Disponível: ${produto.estoque_quantidade} un.`);
    }
    return {
      quantidade: qtd,
      valorDesejadoCentavos: null,
      precoUnitarioSnapshot: precoUnitario,
      subtotalCentavos: qtd * precoUnitario,
    };
  }

  if (modoCompra === 'PESO_KG') {
    const qtd = Number(Number(quantidadeInput || 0).toFixed(precisao));
    if (qtd <= 0) throw new Error('Informe um peso válido maior que zero.');
    if (qtd > Number(produto.estoque_quantidade)) {
      throw new Error(`Estoque insuficiente. Disponível: ${produto.estoque_quantidade} kg.`);
    }
    return {
      quantidade: qtd,
      valorDesejadoCentavos: null,
      precoUnitarioSnapshot: precoUnitario,
      subtotalCentavos: Math.round(qtd * precoUnitario),
    };
  }

  throw new Error('Modalidade de compra inválida. Use UNIDADE ou PESO_KG.');
}

// ==============================================================================
// PUBLIC STORE CONFIG & VIACEP
// ==============================================================================

apiRouter.get('/config/public', async (_req, res) => {
  const cfg = await getConfigMap();
  const storageInfo = getStorageModeInfo();
  res.json({
    frete_padrao_centavos: Number(cfg.frete_padrao_centavos || 499),
    max_parcelas: 1,
    parcelas_sem_juros: 1,
    taxa_juros_mensal: 0,
    exibir_esgotados_catalogo: cfg.exibir_esgotados_catalogo !== 'false',
    whatsapp_loja: cfg.whatsapp_loja || '5511999999999',
    precisao_pesagem_padrao: Number(cfg.precisao_pesagem_padrao || 3),
    pix_key_configurada: Boolean(cfg.pix_key && String(cfg.pix_key).trim()),
    pix_key_type: (cfg.pix_key_type as any) || 'CPF',
    mercado_pago_public_key: process.env.MERCADOPAGO_PUBLIC_KEY || '',
    mercado_pago_configurado: Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN),
    database_engine: storageInfo.engine,
    supabase_url: storageInfo.supabaseUrl,
  });
});

apiRouter.get('/cep/:cep', optionalAuth, async (req, res) => {
  const cep = cleanDigits(req.params.cep);
  if (cep.length !== 8) {
    return res.status(400).json({ error: 'CEP inválido. Informe 8 dígitos.' });
  }
  try {
    const resp = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    if (!resp.ok) {
      return res.status(502).json({ error: 'Não foi possível consultar o serviço ViaCEP.' });
    }
    const data: any = await resp.json();
    if (data.erro) {
      return res.status(404).json({ error: 'CEP não encontrado na base dos Correios.' });
    }
    res.json({
      cep,
      rua: data.logradouro || '',
      bairro: data.bairro || '',
      cidade: data.localidade || '',
      estado: data.uf || '',
      complemento: data.complemento || '',
    });
  } catch (err: any) {
    res.status(502).json({ error: 'Erro ao consultar ViaCEP: ' + (err?.message || 'falha de rede') });
  }
});

// ==============================================================================
// UNIFIED AUTHENTICATION (Exclusively CPF + Password, 1 registration per CPF)
// ==============================================================================

apiRouter.post('/auth/validate-phone', async (req, res) => {
  const digits = cleanDigits(String(req.body?.telefone || req.body?.phone || ''));
  return res.json({ valid: true, active: true, normalized: digits });
});

apiRouter.post('/auth/register', async (req, res) => {
  try {
    const body = req.body || {};
    const fullName = String(body.nome_completo ?? body.full_name ?? '').trim();
    const rawCpf = body.cpf;
    const cleanPhone = cleanDigits(String(body.telefone ?? body.phone ?? ''));
    const senha = String(body.senha ?? body.password ?? '');
    const confirmacao = body.confirmacao_senha ?? body.confirm_password;

    if (fullName.length < 3 || !fullName.includes(' ')) {
      return res.status(400).json({
        error: 'Informe seu nome completo (nome e sobrenome).',
      });
    }

    const cpf = cleanDigits(String(rawCpf || ''));
    if (!isValidCPF(cpf)) {
      return res.status(400).json({ error: 'CPF inválido. Verifique os 11 dígitos informados.' });
    }

    if (cleanPhone.length < 8) {
      return res.status(400).json({
        error: 'Informe seu telefone / WhatsApp.',
      });
    }

    const pwCheck = validatePasswordStrength(senha);
    if (!pwCheck.valid) {
      return res.status(400).json({ error: pwCheck.errors[0], details: pwCheck.errors });
    }
    if (confirmacao !== undefined && senha !== confirmacao) {
      return res.status(400).json({ error: 'A confirmação da senha não confere.' });
    }

    const created = await registerUserByCpfPassword({
      cpf,
      senha,
      nome_completo: fullName,
      telefone: cleanPhone,
    });

    const token = signSessionToken({
      id: created.id,
      cpf: created.cpf,
      nome: created.nome_completo,
      email: created.email,
      papel: created.papel,
    });
    setSessionCookie(req, res, token);

    res.status(201).json({
      token,
      user: {
        ...created,
        email_verificado: true,
        telefone_verificado: true,
        identidade_verificada: true,
      },
    });
  } catch (err: any) {
    const msg = err?.message || 'Erro ao concluir o cadastro.';
    const status = msg.toLowerCase().includes('já está cadastrado') ? 409 : 500;
    res.status(status).json({ error: msg });
  }
});

apiRouter.post('/auth/login', async (req, res) => {
  const cpf = cleanDigits(String(req.body?.cpf || ''));
  const senha = String(req.body?.senha || '');

  if (!isValidCPF(cpf) || !senha) {
    return res.status(400).json({ error: 'Informe um CPF válido e sua senha.' });
  }

  const rateKey = `${cpf}:${req.ip || 'unknown'}`;
  const limit = await checkRateLimit(rateKey);
  if (!limit.allowed) {
    return res.status(429).json({
      error: `Muitas tentativas de login. Aguarde ${limit.minutesRemaining} minuto(s) para tentar novamente.`,
    });
  }

  const authenticated = await authenticateUserByCpfPassword(cpf, senha);
  if (!authenticated) {
    await recordFailedAttempt(rateKey);
    return res.status(401).json({ error: 'CPF ou senha inválidos.' });
  }

  await clearFailedAttempts(rateKey);
  const token = signSessionToken({
    id: authenticated.id,
    cpf: authenticated.cpf,
    nome: authenticated.nome_completo,
    email: authenticated.email,
    papel: authenticated.papel,
  });
  setSessionCookie(req, res, token);

  res.json({
    token,
    user: {
      ...authenticated,
      email_verificado: true,
      telefone_verificado: true,
      identidade_verificada: true,
    },
  });
});

apiRouter.post('/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

apiRouter.get('/auth/me', optionalAuth, async (req: AuthRequest, res) => {
  if (!req.user) return res.json({ user: null });
  const profile = await getUserProfileById(req.user.id, req.user.papel);
  res.json({ user: profile });
});

// ==============================================================================
// OPEN PUBLIC CATALOG & SMART SEARCH (Visible immediately without login)
// ==============================================================================

apiRouter.get('/categorias', optionalAuth, async (_req, res) => {
  const rows = await listCategorias();
  res.json(rows);
});

apiRouter.get('/produtos', optionalAuth, async (req: AuthRequest, res) => {
  const cfg = await getConfigMap();
  const showOutOfStock = req.user?.papel === 'ADMIN' || cfg.exibir_esgotados_catalogo !== 'false';

  const q = String(req.query.q || '').trim();
  const categoria = String(req.query.categoria || '').trim();
  const disponibilidade = String(req.query.disponibilidade || '').trim();
  const ofertas = req.query.ofertas === 'true';
  const destaques = req.query.destaques === 'true';
  const precoMin = req.query.precoMin ? Number(req.query.precoMin) : null;
  const precoMax = req.query.precoMax ? Number(req.query.precoMax) : null;

  let products = await listProdutos(false);

  if (!showOutOfStock) products = products.filter((p) => p.situacao === 'DISPONIVEL');
  if (categoria) products = products.filter((p) => p.categoria_slug === categoria || p.categoria_id === categoria);
  if (disponibilidade === 'DISPONIVEL' || disponibilidade === 'ESGOTADO') {
    products = products.filter((p) => p.situacao === disponibilidade);
  }
  if (ofertas) products = products.filter((p) => p.oferta === 1);
  if (destaques) products = products.filter((p) => p.destaque === 1);
  if (precoMin !== null && !Number.isNaN(precoMin)) {
    products = products.filter((p) => p.preco_vigente_centavos >= Math.round(precoMin * 100));
  }
  if (precoMax !== null && !Number.isNaN(precoMax)) {
    products = products.filter((p) => p.preco_vigente_centavos <= Math.round(precoMax * 100));
  }

  if (q) {
    const stopWords = new Set(['de', 'da', 'do', 'das', 'dos', 'para', 'com', 'e', 'em', 'por']);
    const normalizedQuery = normalizeText(q);
    const tokens = normalizedQuery.split(/\s+/).filter((t) => t.length >= 2 && !stopWords.has(t));

    products = products
      .map((p) => {
        const haystack = [
          p.nome_normalizado,
          normalizeText(p.descricao_completa),
          normalizeText(p.observacao_curta),
          normalizeText(p.categoria_nome || ''),
          p.palavras_chave_normalizadas || '',
        ].join(' ');
        let score = 0;
        if (haystack.includes(normalizedQuery)) score += 10;
        for (const tk of tokens) {
          if ((p.nome_normalizado || '').includes(tk)) score += 5;
          if ((p.palavras_chave_normalizadas || '').includes(tk)) score += 4;
          if (normalizeText(p.categoria_nome || '').includes(tk)) score += 3;
          if (haystack.includes(tk)) score += 2;
        }
        return { product: p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.product);
  }

  res.json(products);
});

apiRouter.get('/produtos/:id', optionalAuth, async (req, res) => {
  const prod = await getProdutoById(req.params.id);
  if (!prod || prod.situacao === 'INATIVO') {
    return res.status(404).json({ error: 'Produto não encontrado.' });
  }
  res.json(prod);
});

// ==============================================================================
// PERSISTENT CART
// ==============================================================================

apiRouter.get('/carrinho', requireCliente, async (req: AuthRequest, res) => {
  res.json(await getCartPayload(req.user!.id));
});

apiRouter.post('/carrinho/itens', requireCliente, async (req: AuthRequest, res) => {
  try {
    const { produtoId, modoCompra, quantidade } = req.body || {};
    const produto = await getProdutoById(produtoId);
    if (!produto || produto.situacao === 'INATIVO') {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    if (produto.situacao === 'ESGOTADO' || produto.estoque_quantidade <= 0) {
      return res.status(400).json({ error: 'Produto esgotado no momento.' });
    }

    const expectedMode = produto.unit_type === 'kg' ? 'PESO_KG' : 'UNIDADE';
    const resolvedMode = modoCompra || expectedMode;
    if (resolvedMode !== expectedMode) {
      return res.status(400).json({
        error:
          expectedMode === 'UNIDADE'
            ? 'Este produto é vendido apenas por unidade.'
            : 'Este produto é vendido apenas por quilo (kg).',
      });
    }

    const calc = computeCartItemValues(produto, resolvedMode, quantidade);
    await addOrMergeCartItem(req.user!.id, produto, resolvedMode, calc, computeCartItemValues);
    res.json(await getCartPayload(req.user!.id));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Não foi possível adicionar ao carrinho.' });
  }
});

apiRouter.patch('/carrinho/itens/:itemId', requireCliente, async (req: AuthRequest, res) => {
  try {
    await updateCartItemRepo(req.user!.id, req.params.itemId, req.body, computeCartItemValues);
    res.json(await getCartPayload(req.user!.id));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao atualizar item do carrinho.' });
  }
});

apiRouter.delete('/carrinho/itens/:itemId', requireCliente, async (req: AuthRequest, res) => {
  await removeCartItemRepo(req.user!.id, req.params.itemId);
  res.json(await getCartPayload(req.user!.id));
});

// ==============================================================================
// CLIENT ADDRESSES
// ==============================================================================

apiRouter.get('/enderecos', requireCliente, async (req: AuthRequest, res) => {
  res.json(await listEnderecosByCliente(req.user!.id));
});

apiRouter.post('/enderecos', requireCliente, async (req: AuthRequest, res) => {
  const { cep, rua, numero, complemento, bairro, cidade, estado } = req.body || {};
  const cleanCep = cleanDigits(String(cep || ''));
  if (cleanCep.length !== 8 || !rua || !numero || !bairro || !cidade || !estado) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios do endereço.' });
  }
  const created = await createEndereco(req.user!.id, {
    cep: cleanCep,
    rua,
    numero,
    complemento,
    bairro,
    cidade,
    estado,
  });
  res.status(201).json(created);
});

// ==============================================================================
// MERCADO PAGO & ORDERS
// ==============================================================================

async function mpApiRequest(endpoint: string, options: RequestInit = {}) {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) throw new Error('MERCADOPAGO_NOT_CONFIGURED');
  const resp = await fetch(`https://api.mercadopago.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.message || data?.cause?.[0]?.description || `Erro Mercado Pago (${resp.status})`;
    throw new Error(msg);
  }
  return data;
}

function mapMpStatusToLocal(mpStatus: string): {
  paymentStatus: 'PENDENTE' | 'APROVADO' | 'RECUSADO' | 'CANCELADO' | 'ESTORNADO';
  orderFinanceStatus: 'AGUARDANDO_PAGAMENTO' | 'PAGO' | 'RECUSADO' | 'CANCELADO' | 'ESTORNADO';
} {
  switch (mpStatus) {
    case 'approved':
      return { paymentStatus: 'APROVADO', orderFinanceStatus: 'PAGO' };
    case 'rejected':
      return { paymentStatus: 'RECUSADO', orderFinanceStatus: 'RECUSADO' };
    case 'cancelled':
      return { paymentStatus: 'CANCELADO', orderFinanceStatus: 'CANCELADO' };
    case 'refunded':
    case 'charged_back':
      return { paymentStatus: 'ESTORNADO', orderFinanceStatus: 'ESTORNADO' };
    default:
      return { paymentStatus: 'PENDENTE', orderFinanceStatus: 'AGUARDANDO_PAGAMENTO' };
  }
}

apiRouter.get('/pagamentos/mp/parcelas', requireAuth, async (req, res) => {
  const amount = Number(req.query.amount || 0);
  const bin = cleanDigits(String(req.query.bin || ''));

  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    return res.json({
      configured: false,
      maxParcelas: 1,
      parcelasSemJuros: 1,
      options: [],
    });
  }
  if (!amount || amount <= 0 || bin.length < 6) {
    return res.json({ configured: true, maxParcelas: 1, parcelasSemJuros: 1, options: [] });
  }
  try {
    const data: any = await mpApiRequest(
      `/v1/payment_methods/installments?amount=${amount.toFixed(2)}&bin=${bin.slice(0, 6)}&locale=pt-BR`
    );
    const payerCosts = data?.[0]?.payer_costs || [];
    const filtered = payerCosts
      .filter((pc: any) => pc.installments === 1)
      .map((pc: any) => ({
        installments: 1,
        installment_amount: pc.installment_amount,
        total_amount: pc.total_amount,
        recommended_message: pc.recommended_message,
        sem_juros: true,
      }));
    res.json({
      configured: true,
      payment_method_id: data?.[0]?.payment_method_id,
      issuer_id: data?.[0]?.issuer?.id,
      options: filtered,
    });
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Erro ao consultar dados do cartão no Mercado Pago.' });
  }
});

async function handleCreateOrder(req: AuthRequest, res: express.Response) {
  const { endereco, formaPagamento, observacoes, cardPayment, itens } = req.body || {};

  if (!['PIX', 'CARTAO_CREDITO', 'DINHEIRO_NA_ENTREGA'].includes(formaPagamento)) {
    return res.status(400).json({ error: 'Forma de pagamento inválida.' });
  }
  const cep = cleanDigits(String(endereco?.cep || ''));
  if (cep.length !== 8 || !endereco?.rua || !endereco?.numero || !endereco?.bairro || !endereco?.cidade || !endereco?.estado) {
    return res.status(400).json({ error: 'Endereço de entrega incompleto.' });
  }
  if (formaPagamento === 'CARTAO_CREDITO' && !cardPayment?.token) {
    return res.status(400).json({ error: 'Token de cartão obrigatório. Utilize a tokenização segura do Mercado Pago.' });
  }

  const cliente = await getUserProfileById(req.user!.id, 'CLIENTE');
  if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado.' });

  await updateProfileContactInfo(cliente.id, {
    full_name: endereco?.nome_destinatario,
    phone: endereco?.telefone_contato,
  });

  const cfg = await getConfigMap();
  const adminPixKey = String(cfg.pix_key || '').trim();
  const adminPixKeyType = String(cfg.pix_key_type || 'CPF').trim();
  const adminPixRecipient = String(cfg.pix_recipient_name || 'Agro Marconato Agropecuária').trim();

  const numParcelas = 1;

  let createdOrder: any;
  try {
    createdOrder = await createOrderFromCartRepo({
      cliente,
      endereco,
      cep,
      formaPagamento,
      numParcelas,
      observacoes: String(observacoes || '').trim(),
      computeFn: computeCartItemValues,
      directItems: Array.isArray(itens) ? itens : undefined,
    });
  } catch (err: any) {
    return res.status(409).json({ error: err?.message || 'Não foi possível criar o pedido.' });
  }

  const idempotencyKey = `agro-order-${createdOrder.id}`;
  let paymentRecord: any = null;
  let paymentNotice: string | null = null;

  if (formaPagamento === 'DINHEIRO_NA_ENTREGA') {
    paymentRecord = await saveOrderPaymentRepo({
      pedido_id: createdOrder.id,
      provedor: 'LOJA_ENTREGA',
      idempotency_key: idempotencyKey,
      forma_pagamento: 'DINHEIRO_NA_ENTREGA',
      valor_centavos: createdOrder.total_centavos,
      parcelas: 1,
      status: 'PENDENTE',
    });
  } else {
    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    const notificationUrl = appUrl ? `${appUrl}/api/webhooks/mercadopago` : undefined;
    const displayName = String(endereco?.nome_destinatario || cliente.nome_completo || 'Cliente').trim();
    const [firstName, ...restName] = displayName.split(' ');
    const lastName = restName.join(' ') || firstName;
    const rawEmail = String(endereco?.email_comprovante || '').trim().toLowerCase();
    const payerEmail =
      isValidEmail(rawEmail) && !rawEmail.endsWith('.local')
        ? rawEmail
        : isValidEmail(cliente.email) && !cliente.email.endsWith('.local')
        ? cliente.email
        : `cliente-${cliente.cpf}@agromarconato.com.br`;

    try {
      const mpBody: any = {
        transaction_amount: Number((createdOrder.total_centavos / 100).toFixed(2)),
        description: `Pedido #${createdOrder.numero_pedido} — Agro Marconato Agropecuária`,
        external_reference: createdOrder.id,
        metadata: {
          order_id: createdOrder.id,
          numero_pedido: createdOrder.numero_pedido,
          admin_pix_key: adminPixKey,
          admin_pix_key_type: adminPixKeyType,
          admin_pix_recipient: adminPixRecipient,
        },
        payer: {
          email: payerEmail,
          first_name: firstName,
          last_name: lastName,
          identification: { type: 'CPF', number: cliente.cpf },
        },
      };
      if (notificationUrl && notificationUrl.startsWith('https://')) {
        mpBody.notification_url = notificationUrl;
      }
      if (formaPagamento === 'PIX') {
        mpBody.payment_method_id = 'pix';
      } else if (formaPagamento === 'CARTAO_CREDITO') {
        mpBody.token = cardPayment.token;
        mpBody.installments = numParcelas;
        mpBody.payment_method_id = cardPayment.payment_method_id;
        if (cardPayment.issuer_id) mpBody.issuer_id = cardPayment.issuer_id;
      }

      const mpData: any = await mpApiRequest('/v1/payments', {
        method: 'POST',
        headers: { 'X-Idempotency-Key': idempotencyKey },
        body: JSON.stringify(mpBody),
      });

      const mapped = mapMpStatusToLocal(mpData.status);
      const qrCode = mpData?.point_of_interaction?.transaction_data?.qr_code || null;
      let qrBase64 = mpData?.point_of_interaction?.transaction_data?.qr_code_base64 || null;
      if (qrCode && !qrBase64) {
        const dataUrl = await QRCode.toDataURL(qrCode, { width: 260, margin: 1 });
        qrBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      }

      paymentRecord = await saveOrderPaymentRepo({
        pedido_id: createdOrder.id,
        provedor: 'MERCADO_PAGO',
        external_id: String(mpData.id),
        idempotency_key: idempotencyKey,
        forma_pagamento: formaPagamento,
        valor_centavos: createdOrder.total_centavos,
        parcelas: numParcelas,
        status: mapped.paymentStatus,
        pix_qr_code: qrCode,
        pix_qr_code_base64: qrBase64,
        payload_bruto: { id: mpData.id, status: mpData.status, status_detail: mpData.status_detail },
        newOrderFinanceStatus: mapped.orderFinanceStatus,
        historyDesc: `Mercado Pago retornou status: ${mpData.status} (${mpData.status_detail || 'processado'}).`,
      });
    } catch (err: any) {
      const notConfigured = err?.message === 'MERCADOPAGO_NOT_CONFIGURED';
      paymentNotice = notConfigured
        ? 'Pedido criado como AGUARDANDO_PAGAMENTO. Para gerar cobrança PIX/Cartão real, configure MERCADOPAGO_ACCESS_TOKEN e MERCADOPAGO_PUBLIC_KEY no servidor.'
        : `Pedido registrado, mas houve falha na comunicação com o Mercado Pago: ${err?.message}`;

      paymentRecord = await saveOrderPaymentRepo({
        pedido_id: createdOrder.id,
        provedor: 'MERCADO_PAGO',
        idempotency_key: idempotencyKey,
        forma_pagamento: formaPagamento,
        valor_centavos: createdOrder.total_centavos,
        parcelas: numParcelas,
        status: 'PENDENTE',
        payload_bruto: { error: err?.message },
      });
    }
  }

  const fullOrder = await getOrderByIdRepo(createdOrder.id);
  broadcastOrderUpdate(cliente.id, fullOrder);
  res.status(201).json({ pedido: fullOrder, pagamento: paymentRecord, paymentNotice });
}

apiRouter.post('/pedidos', requireCliente, handleCreateOrder);
apiRouter.post('/checkout', requireCliente, handleCreateOrder);

apiRouter.get('/pedidos', requireCliente, async (req: AuthRequest, res) => {
  res.json(await listOrdersRepo(req.user!.id));
});

apiRouter.get('/pedidos/:id', requireAuth, async (req: AuthRequest, res) => {
  const order = await getOrderByIdRepo(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (req.user!.papel !== 'ADMIN' && order.cliente_id !== req.user!.id) {
    return res.status(403).json({ error: 'Você não tem permissão para acessar este pedido.' });
  }
  res.json(order);
});

apiRouter.post('/pedidos/:id/verificar-pagamento', requireAuth, async (req: AuthRequest, res) => {
  const order = await getOrderByIdRepo(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (req.user!.papel !== 'ADMIN' && order.cliente_id !== req.user!.id) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const pagamento = order.pagamentos?.[0];
  if (!pagamento?.external_id || pagamento.provedor !== 'MERCADO_PAGO') {
    return res.json({ pedido: order, note: 'Nenhuma cobrança externa vinculada para consulta.' });
  }

  try {
    const mpData: any = await mpApiRequest(`/v1/payments/${pagamento.external_id}`);
    const mapped = mapMpStatusToLocal(mpData.status);
    const updatedInfo = await applyPaymentStatusRepo(
      String(mpData.id),
      String(mpData.external_reference || ''),
      Math.round(Number(mpData.transaction_amount || 0) * 100),
      mapped.paymentStatus,
      mapped.orderFinanceStatus,
      mpData.status,
      'consulta_manual'
    );
    const updated = await getOrderByIdRepo(order.id);
    if (updatedInfo) broadcastOrderUpdate(updatedInfo.clienteId, updated);
    res.json({ pedido: updated });
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Erro ao consultar pagamento no Mercado Pago.' });
  }
});

async function handleMercadoPagoWebhook(req: express.Request, res: express.Response) {
  try {
    const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
    const xSignature = req.headers['x-signature'] as string | undefined;
    const xRequestId = req.headers['x-request-id'] as string | undefined;
    const dataId = String(req.query['data.id'] || req.body?.data?.id || '');
    const eventType = String(req.query.type || req.body?.type || req.body?.action || '');

    if (secret) {
      const ok = verifyMercadoPagoWebhookSignature({ xSignature, xRequestId, dataId, secret });
      if (!ok) return res.status(401).json({ error: 'Assinatura de Webhook inválida.' });
    } else if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
      return res.status(503).json({ error: 'Credenciais Mercado Pago não configuradas.' });
    }

    if (!dataId || (!eventType.includes('payment') && req.body?.topic !== 'payment')) {
      return res.status(200).json({ ignored: true });
    }

    const eventKey = `${eventType}:${dataId}:${req.body?.id || xRequestId || ''}`;
    if (await isWebhookProcessedRepo(eventKey)) {
      return res.status(200).json({ deduplicated: true });
    }

    const mpData: any = await mpApiRequest(`/v1/payments/${dataId}`);
    const mapped = mapMpStatusToLocal(mpData.status);
    const updatedInfo = await applyPaymentStatusRepo(
      String(mpData.id),
      String(mpData.external_reference || ''),
      Math.round(Number(mpData.transaction_amount || 0) * 100),
      mapped.paymentStatus,
      mapped.orderFinanceStatus,
      mpData.status,
      'webhook_mercadopago'
    );

    await markWebhookProcessedRepo(eventKey, dataId);
    if (updatedInfo) {
      const updated = await getOrderByIdRepo(updatedInfo.pedidoId);
      broadcastOrderUpdate(updatedInfo.clienteId, updated);
    }

    res.status(200).json({ processed: true });
  } catch (err: any) {
    console.error('Erro webhook Mercado Pago:', err);
    res.status(500).json({ error: 'Falha ao processar notificação.' });
  }
}

apiRouter.post('/webhooks/mercadopago', handleMercadoPagoWebhook);
apiRouter.post('/webhook', handleMercadoPagoWebhook);

// ==============================================================================
// REAL-TIME CHAT
// ==============================================================================

apiRouter.get('/conversas', requireAuth, async (req: AuthRequest, res) => {
  res.json(await listConversationsRepo(req.user!));
});

apiRouter.post('/conversas', requireCliente, async (req: AuthRequest, res) => {
  try {
    const pedidoId = req.body?.pedidoId ? String(req.body.pedidoId) : null;
    const assunto = String(req.body?.assunto || '').trim();
    const conv = await getOrCreateConversationRepo(req.user!.id, pedidoId, assunto);
    res.status(201).json(conv);
  } catch (err: any) {
    res.status(404).json({ error: err?.message || 'Pedido não encontrado.' });
  }
});

apiRouter.get('/conversas/:id/mensagens', requireAuth, async (req: AuthRequest, res) => {
  const result = await getConversationMessagesRepo(req.params.id, req.user!);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.json(result.messages);
});

apiRouter.post('/conversas/:id/mensagens', requireAuth, async (req: AuthRequest, res) => {
  const conteudo = String(req.body?.conteudo || '').trim();
  if (!conteudo || conteudo.length > 2000) {
    return res.status(400).json({ error: 'Mensagem deve ter entre 1 e 2000 caracteres.' });
  }
  const result = await addConversationMessageRepo(req.params.id, req.user!, conteudo);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  broadcastChatMessage(result.clienteId!, result.message);
  res.status(201).json(result.message);
});

// ==============================================================================
// ADMIN ROUTES (/api/admin/*)
// ==============================================================================

apiRouter.get('/admin/dashboard', requireAdmin, async (_req, res) => {
  res.json(await getAdminDashboardRepo());
});

apiRouter.get('/admin/produtos', requireAdmin, async (_req, res) => {
  res.json(await listProdutos(true));
});

apiRouter.post('/admin/produtos', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.categoria_id || !b.nome || b.preco_centavos === undefined) {
      return res.status(400).json({ error: 'Preencha categoria, nome e preço do produto.' });
    }
    const created = await createProduto({
      ...b,
      observacao_curta: b.observacao_curta || b.nome,
      descricao_completa: b.descricao_completa || b.observacao_curta || b.nome,
    });
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao cadastrar produto.' });
  }
});

apiRouter.patch('/admin/produtos/:id', requireAdmin, async (req, res) => {
  try {
    const updated = await updateProduto(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao atualizar produto.' });
  }
});

apiRouter.delete('/admin/produtos/:id', requireAdmin, async (req, res) => {
  const prod = await getProdutoById(req.params.id);
  if (!prod) return res.status(404).json({ error: 'Produto não encontrado.' });
  res.json(await deleteOrInactivateProduto(req.params.id));
});

apiRouter.post(
  '/admin/produtos/:id/imagens',
  requireAdmin,
  (req, res, next) => {
    upload.array('imagens', 6)(req, res, (err: any) => {
      if (err) return res.status(400).json({ error: err.message || 'Erro no upload de imagem.' });
      next();
    });
  },
  async (req, res) => {
    try {
      const prod = await getProdutoById(req.params.id);
      if (!prod) return res.status(404).json({ error: 'Produto não encontrado.' });
      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'Selecione pelo menos uma imagem JPG, PNG ou WEBP.' });
      }
      const created = await uploadProductImages(req.params.id, files);
      res.status(201).json(created);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao salvar imagens.' });
    }
  }
);

apiRouter.patch('/admin/produtos/:id/imagens/:imgId/principal', requireAdmin, async (req, res) => {
  await setPrimaryProductImage(req.params.id, req.params.imgId);
  res.json({ ok: true });
});

apiRouter.delete('/admin/produtos/:id/imagens/:imgId', requireAdmin, async (req, res) => {
  const ok = await deleteProductImage(req.params.id, req.params.imgId);
  if (!ok) return res.status(404).json({ error: 'Imagem não encontrada.' });
  res.json({ ok: true });
});

apiRouter.patch('/admin/produtos/:id/estoque', requireAdmin, async (req, res) => {
  const qtd = Math.max(0, Number(req.body?.estoque_quantidade ?? 0));
  const updated = await updateProduto(req.params.id, { estoque_quantidade: qtd });
  if (!updated) return res.status(404).json({ error: 'Produto não encontrado.' });
  res.json({ id: updated.id, estoque_quantidade: updated.estoque_quantidade, situacao: updated.situacao });
});

apiRouter.post('/admin/categorias', requireAdmin, async (req, res) => {
  const nome = String(req.body?.nome || '').trim();
  const descricao = String(req.body?.descricao || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome da categoria é obrigatório.' });
  try {
    res.status(201).json(await createCategoria(nome, descricao));
  } catch (err: any) {
    res.status(409).json({ error: err?.message || 'Categoria já cadastrada.' });
  }
});

apiRouter.get('/admin/pedidos', requireAdmin, async (_req, res) => {
  res.json(await listOrdersRepo());
});

apiRouter.patch('/admin/pedidos/:id/status', requireAdmin, async (req: AuthRequest, res) => {
  const { situacao_entrega, observacao } = req.body || {};
  const allowed = ['CONFIRMADO', 'EM_PREPARACAO', 'SAIU_PARA_ENTREGA', 'ENTREGUE', 'CANCELADO'];
  if (!allowed.includes(situacao_entrega)) {
    return res.status(400).json({ error: 'Status de entrega inválido.' });
  }
  const clienteId = await updateOrderDeliveryStatusRepo(req.params.id, situacao_entrega, observacao, req.user!.id);
  if (!clienteId) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const updated = await getOrderByIdRepo(req.params.id);
  broadcastOrderUpdate(clienteId, updated);
  res.json(updated);
});

apiRouter.post('/admin/pedidos/:id/quitar-dinheiro', requireAdmin, async (req: AuthRequest, res) => {
  const result = await settleCashOrderRepo(req.params.id, req.user!.id);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  const updated = await getOrderByIdRepo(req.params.id);
  if (result.clienteId) broadcastOrderUpdate(result.clienteId, updated);
  res.json(updated);
});

apiRouter.get('/admin/clientes', requireAdmin, async (_req, res) => {
  res.json(await listClientesAdminRepo());
});

apiRouter.post('/admin/clientes', requireAdmin, async (req, res) => {
  const { nome_completo, cpf: rawCpf, telefone: rawTel, senha } = req.body || {};
  const cpf = cleanDigits(String(rawCpf || ''));
  const telefone = cleanDigits(String(rawTel || ''));

  if (!nome_completo || !isValidCPF(cpf)) {
    return res.status(400).json({ error: 'Nome e CPF válido são obrigatórios.' });
  }
  const pw = validatePasswordStrength(String(senha || '123456'));
  if (!pw.valid) return res.status(400).json({ error: pw.errors[0] });

  try {
    const created = await registerUserByCpfPassword({
      cpf,
      senha: String(senha || '123456'),
      nome_completo: String(nome_completo).trim(),
      telefone,
    });
    res.status(201).json(created);
  } catch (err: any) {
    const msg = err?.message || 'Erro ao cadastrar cliente.';
    res.status(msg.toLowerCase().includes('já está cadastrado') ? 409 : 400).json({ error: msg });
  }
});

apiRouter.get('/admin/administradores', requireAdmin, async (_req, res) => {
  res.json(await listAdminsRepo());
});

apiRouter.post('/admin/administradores', requireAdmin, async (req: AuthRequest, res) => {
  const { nome_completo, cpf: rawCpf, email: rawEmail, telefone: rawTel, senha } = req.body || {};
  const cpf = cleanDigits(String(rawCpf || ''));
  const email = String(rawEmail || '').trim().toLowerCase();
  const telefone = cleanDigits(String(rawTel || ''));

  if (!nome_completo || !isValidCPF(cpf) || !isValidEmail(email) || !isValidBrazilPhone(telefone)) {
    return res.status(400).json({ error: 'Preencha nome, CPF válido, e-mail e telefone com DDD.' });
  }
  const pw = validatePasswordStrength(String(senha || ''));
  if (!pw.valid) return res.status(400).json({ error: pw.errors[0] });

  try {
    const created = await createAdminRepo({
      nome_completo: String(nome_completo).trim(),
      cpf,
      email,
      telefone,
      senha: String(senha),
      criado_por: req.user!.id,
    });
    res.status(201).json(created);
  } catch (err: any) {
    res.status(409).json({ error: err?.message || 'CPF ou e-mail já cadastrado.' });
  }
});

apiRouter.get('/admin/configuracoes', requireAdmin, async (_req, res) => {
  const cfg = await getConfigMap();
  res.json({
    frete_padrao_centavos: Number(cfg.frete_padrao_centavos || 499),
    exibir_esgotados_catalogo: cfg.exibir_esgotados_catalogo !== 'false',
    whatsapp_loja: cfg.whatsapp_loja || '5511999999999',
    precisao_pesagem_padrao: Number(cfg.precisao_pesagem_padrao || 3),
    pix_key: cfg.pix_key || '',
    pix_key_type: cfg.pix_key_type || 'CPF',
    pix_recipient_name: cfg.pix_recipient_name || 'Agro Marconato Agropecuária',
  });
});

apiRouter.put('/admin/configuracoes', requireAdmin, async (req, res) => {
  const pixKeyType = String(req.body?.pix_key_type || 'CPF').toUpperCase();
  const allowedPixTypes = ['CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'EVP'];
  if (!allowedPixTypes.includes(pixKeyType)) {
    return res.status(400).json({ error: 'Tipo de chave Pix inválido.' });
  }

  let pixKey = String(req.body?.pix_key ?? '').trim();
  if (pixKey) {
    if (pixKeyType === 'CPF') {
      const digits = cleanDigits(pixKey);
      if (!isValidCPF(digits)) {
        return res.status(400).json({ error: 'Chave Pix CPF inválida. Verifique os 11 dígitos.' });
      }
      pixKey = digits;
    } else if (pixKeyType === 'EMAIL') {
      pixKey = pixKey.toLowerCase();
      if (!isValidEmail(pixKey)) {
        return res.status(400).json({ error: 'Chave Pix E-mail inválida.' });
      }
    } else if (pixKeyType === 'TELEFONE') {
      const digits = cleanDigits(pixKey);
      if (!isValidBrazilPhone(digits)) {
        return res.status(400).json({ error: 'Chave Pix Telefone inválida (informe DDD + número).' });
      }
      pixKey = digits;
    } else if (pixKeyType === 'CNPJ') {
      const digits = cleanDigits(pixKey);
      if (digits.length !== 14) {
        return res.status(400).json({ error: 'Chave Pix CNPJ deve conter 14 dígitos.' });
      }
      pixKey = digits;
    } else if (pixKeyType === 'EVP' && pixKey.length < 16) {
      return res.status(400).json({ error: 'Chave aleatória (EVP) inválida.' });
    }
  }

  const allowedKeys = [
    'frete_padrao_centavos',
    'exibir_esgotados_catalogo',
    'whatsapp_loja',
    'precisao_pesagem_padrao',
    'pix_recipient_name',
  ];
  const entries: Record<string, string> = {};
  for (const key of allowedKeys) {
    if (req.body?.[key] !== undefined) entries[key] = String(req.body[key]);
  }
  if (req.body?.pix_key !== undefined) entries.pix_key = pixKey;
  if (req.body?.pix_key_type !== undefined) entries.pix_key_type = pixKeyType;
  entries.max_parcelas = '1';
  entries.parcelas_sem_juros = '1';
  entries.taxa_juros_mensal = '0';
  res.json(await updateConfigMap(entries));
});
