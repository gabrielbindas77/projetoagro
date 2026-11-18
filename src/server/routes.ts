import crypto from 'crypto';
import path from 'path';
import bcrypt from 'bcryptjs';
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
  checkRateLimit,
  clearFailedAttempts,
  createCategoria,
  createCliente,
  createProduto,
  deleteOrInactivateProduto,
  deleteProductImage,
  findAuthAccountByCpf,
  findUserByCpfOrEmail,
  getCartPayload,
  getConfigMap,
  getProdutoById,
  getStorageModeInfo,
  getUserProfileById,
  listCategorias,
  listProdutos,
  markClienteVerified,
  recordFailedAttempt,
  saveVerificationCode,
  setPrimaryProductImage,
  updateClientePasswordByCpf,
  updateConfigMap,
  updateProduto,
  uploadProductImages,
  verifyAndConsumeCode,
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
  dispatchEmailCode,
  dispatchPhoneCode,
  generateNumericCode,
  hashCode,
  isValidBrazilPhone,
  isValidCPF,
  isValidEmail,
  normalizeText,
  validatePasswordStrength,
  verifyExternalCpfIdentity,
  verifyMercadoPagoWebhookSignature,
} from './utils.ts';
import { broadcastChatMessage, broadcastOrderUpdate } from './ws.ts';

export const apiRouter = express.Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
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
  quantidadeInput?: number,
  valorDesejadoCentavosInput?: number
) {
  const precoUnitario = Number(produto.preco_vigente_centavos ?? produto.preco_centavos);
  const precisao = Number(produto.precisao_pesagem ?? 3);

  if (modoCompra === 'UNIDADE') {
    const qtd = Math.floor(Number(quantidadeInput || 0));
    if (qtd < 1) throw new Error('Quantidade mínima é 1 unidade.');
    if (qtd > Number(produto.estoque_quantidade)) {
      throw new Error(`Estoque insuficiente. Disponível: ${produto.estoque_quantidade} ${produto.unidade_venda}.`);
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

  if (modoCompra === 'VALOR_DINHEIRO') {
    const valorCentavos = Math.round(Number(valorDesejadoCentavosInput || 0));
    if (valorCentavos < 100) throw new Error('O valor mínimo para compra por valor é R$ 1,00.');
    if (precoUnitario <= 0) throw new Error('Preço do produto inválido.');
    const fator = Math.pow(10, precisao);
    const qtd = Math.round((valorCentavos / precoUnitario) * fator) / fator;
    if (qtd <= 0) throw new Error('Valor insuficiente para a menor fração de pesagem.');
    if (qtd > Number(produto.estoque_quantidade)) {
      throw new Error(
        `O valor informado equivale a ${qtd.toFixed(precisao)} kg, acima do estoque disponível (${produto.estoque_quantidade} kg).`
      );
    }
    return {
      quantidade: qtd,
      valorDesejadoCentavos: valorCentavos,
      precoUnitarioSnapshot: precoUnitario,
      subtotalCentavos: valorCentavos,
    };
  }

  throw new Error('Modalidade de compra inválida.');
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

apiRouter.get('/cep/:cep', requireAuth, async (req, res) => {
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
// AUTHENTICATION, VERIFICATION & PASSWORD RECOVERY
// ==============================================================================

apiRouter.post('/auth/register', async (req, res) => {
  try {
    const {
      nome_completo,
      cpf: rawCpf,
      email: rawEmail,
      telefone: rawTelefone,
      senha,
      confirmacao_senha,
    } = req.body || {};

    if (!nome_completo || String(nome_completo).trim().length < 3) {
      return res.status(400).json({ error: 'Informe o nome completo válido.' });
    }
    const cpf = cleanDigits(String(rawCpf || ''));
    if (!isValidCPF(cpf)) {
      return res.status(400).json({ error: 'CPF inválido. Verifique os dígitos informados.' });
    }
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'E-mail em formato inválido.' });
    }
    const telefone = cleanDigits(String(rawTelefone || ''));
    if (!isValidBrazilPhone(telefone)) {
      return res.status(400).json({ error: 'Telefone inválido. Informe DDD válido + número.' });
    }
    const pwCheck = validatePasswordStrength(String(senha || ''));
    if (!pwCheck.valid) {
      return res.status(400).json({ error: pwCheck.errors[0], details: pwCheck.errors });
    }
    if (senha !== confirmacao_senha) {
      return res.status(400).json({ error: 'A confirmação da senha não confere.' });
    }

    const dup = await findUserByCpfOrEmail(cpf, email);
    if (dup.cpfExists) {
      return res.status(409).json({ error: 'Este CPF já está cadastrado no sistema.' });
    }
    if (dup.emailExists) {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado no sistema.' });
    }

    const identityCheck = await verifyExternalCpfIdentity(cpf, String(nome_completo).trim());
    if (identityCheck.checked && !identityCheck.verified) {
      return res.status(422).json({
        error: `Falha na validação cadastral do CPF: ${identityCheck.providerMessage}`,
      });
    }

    const senhaHash = bcrypt.hashSync(String(senha), 10);
    const created = await createCliente({
      nome_completo: String(nome_completo).trim(),
      cpf,
      email,
      telefone,
      senha_hash: senhaHash,
      identidade_verificada: identityCheck.verified,
    });

    const emailCode = generateNumericCode();
    const phoneCode = generateNumericCode();
    const expira = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await Promise.all([
      saveVerificationCode(email, 'EMAIL', hashCode(emailCode), expira),
      saveVerificationCode(telefone, 'TELEFONE', hashCode(phoneCode), expira),
    ]);

    const [emailDispatch, phoneDispatch] = await Promise.all([
      dispatchEmailCode(email, emailCode, 'verificacao'),
      dispatchPhoneCode(telefone, phoneCode),
    ]);

    const token = signSessionToken({
      id: created.id,
      cpf,
      nome: String(nome_completo).trim(),
      email,
      papel: 'CLIENTE',
    });
    setSessionCookie(req, res, token);

    res.status(201).json({
      token,
      user: {
        id: created.id,
        nome_completo: String(nome_completo).trim(),
        cpf,
        email,
        telefone,
        papel: 'CLIENTE',
        email_verificado: false,
        telefone_verificado: false,
        identidade_verificada: identityCheck.verified,
      },
      verificacao: {
        email: emailDispatch,
        telefone: phoneDispatch,
        identidade: identityCheck.providerMessage,
      },
    });
  } catch (err: any) {
    console.error('Erro no cadastro:', err);
    res.status(500).json({ error: err?.message || 'Erro interno ao concluir o cadastro.' });
  }
});

apiRouter.post('/auth/verification/send', requireCliente, async (req: AuthRequest, res) => {
  try {
    const tipo = req.body?.tipo === 'TELEFONE' ? 'TELEFONE' : 'EMAIL';
    const cliente = await getUserProfileById(req.user!.id, 'CLIENTE');
    if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const code = generateNumericCode();
    const expira = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const alvo = tipo === 'EMAIL' ? cliente.email : cliente.telefone;

    await saveVerificationCode(alvo, tipo, hashCode(code), expira);
    const dispatch =
      tipo === 'EMAIL'
        ? await dispatchEmailCode(cliente.email, code, 'verificacao')
        : await dispatchPhoneCode(cliente.telefone, code);

    res.json({ ok: true, ...dispatch });
  } catch {
    res.status(500).json({ error: 'Falha ao enviar código de confirmação.' });
  }
});

apiRouter.post('/auth/verification/confirm', requireCliente, async (req: AuthRequest, res) => {
  const tipo = req.body?.tipo === 'TELEFONE' ? 'TELEFONE' : 'EMAIL';
  const codigo = String(req.body?.codigo || '').trim();
  if (!/^\d{6}$/.test(codigo)) {
    return res.status(400).json({ error: 'Informe o código numérico de 6 dígitos.' });
  }
  const cliente = await getUserProfileById(req.user!.id, 'CLIENTE');
  if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const alvo = tipo === 'EMAIL' ? cliente.email : cliente.telefone;
  const check = await verifyAndConsumeCode(alvo, tipo, hashCode(codigo));
  if (!check.ok) return res.status(400).json({ error: check.error });

  await markClienteVerified(cliente.id, tipo);
  res.json({ ok: true, tipo, verificado: true });
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

  const found = await findAuthAccountByCpf(cpf);
  if (!found || !bcrypt.compareSync(senha, found.account.senha_hash)) {
    await recordFailedAttempt(rateKey);
    return res.status(401).json({ error: 'CPF ou senha inválidos.' });
  }

  await clearFailedAttempts(rateKey);
  const acc = found.account;
  const token = signSessionToken({
    id: acc.id,
    cpf: acc.cpf,
    nome: acc.nome_completo,
    email: acc.email,
    papel: found.papel,
  });
  setSessionCookie(req, res, token);

  res.json({
    token,
    user: {
      id: acc.id,
      nome_completo: acc.nome_completo,
      cpf: acc.cpf,
      email: acc.email,
      telefone: acc.telefone,
      papel: found.papel,
      email_verificado: Boolean(acc.email_verificado),
      telefone_verificado: Boolean(acc.telefone_verificado),
      identidade_verificada: Boolean(acc.identidade_verificada),
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

apiRouter.post('/auth/password-recovery/request', async (req, res) => {
  const cpf = cleanDigits(String(req.body?.cpf || ''));
  if (!isValidCPF(cpf)) return res.status(400).json({ error: 'Informe um CPF válido.' });

  const found = await findAuthAccountByCpf(cpf);
  if (!found || found.papel !== 'CLIENTE') {
    return res.json({
      ok: true,
      note: 'Se o CPF estiver cadastrado, enviaremos um código de recuperação para o e-mail vinculado.',
    });
  }

  const code = generateNumericCode();
  const expira = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await saveVerificationCode(cpf, 'RECUPERACAO_SENHA', hashCode(code), expira);
  const dispatch = await dispatchEmailCode(found.account.email, code, 'recuperacao');
  res.json({ ok: true, sent: dispatch.sent, channel: dispatch.channel, note: dispatch.note });
});

apiRouter.post('/auth/password-recovery/reset', async (req, res) => {
  const cpf = cleanDigits(String(req.body?.cpf || ''));
  const codigo = String(req.body?.codigo || '').trim();
  const novaSenha = String(req.body?.nova_senha || '');

  if (!isValidCPF(cpf) || !/^\d{6}$/.test(codigo)) {
    return res.status(400).json({ error: 'CPF ou código de 6 dígitos inválido.' });
  }
  const pw = validatePasswordStrength(novaSenha);
  if (!pw.valid) return res.status(400).json({ error: pw.errors[0] });

  const check = await verifyAndConsumeCode(cpf, 'RECUPERACAO_SENHA', hashCode(codigo));
  if (!check.ok) return res.status(400).json({ error: check.error });

  await updateClientePasswordByCpf(cpf, bcrypt.hashSync(novaSenha, 10));
  res.json({ ok: true });
});

// ==============================================================================
// AUTHENTICATED CATALOG & SMART SEARCH (Requires login before viewing store)
// ==============================================================================

apiRouter.get('/categorias', requireAuth, async (_req, res) => {
  const rows = await listCategorias();
  res.json(rows);
});

apiRouter.get('/produtos', requireAuth, async (req: AuthRequest, res) => {
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

apiRouter.get('/produtos/:id', requireAuth, async (req, res) => {
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
    const { produtoId, modoCompra, quantidade, valorDesejadoCentavos } = req.body || {};
    const produto = await getProdutoById(produtoId);
    if (!produto || produto.situacao === 'INATIVO') {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    if (produto.situacao === 'ESGOTADO' || produto.estoque_quantidade <= 0) {
      return res.status(400).json({ error: 'Produto esgotado no momento.' });
    }
    if (produto.modalidade_venda === 'UNIDADE' && modoCompra !== 'UNIDADE') {
      return res.status(400).json({ error: 'Este produto é vendido apenas por unidade.' });
    }
    if (produto.modalidade_venda === 'PESO_KG' && modoCompra !== 'PESO_KG') {
      return res.status(400).json({ error: 'Este produto é vendido apenas por quilo.' });
    }
    if (produto.modalidade_venda === 'VALOR_DINHEIRO' && modoCompra !== 'VALOR_DINHEIRO') {
      return res.status(400).json({ error: 'Este produto é vendido apenas por valor em dinheiro.' });
    }
    if (produto.modalidade_venda === 'PESO_E_VALOR' && !['PESO_KG', 'VALOR_DINHEIRO'].includes(modoCompra)) {
      return res.status(400).json({ error: 'Selecione compra por quilo ou por valor em R$.' });
    }

    const calc = computeCartItemValues(produto, modoCompra, quantidade, valorDesejadoCentavos);
    await addOrMergeCartItem(req.user!.id, produto, modoCompra, calc, computeCartItemValues);
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

apiRouter.post('/pedidos', requireCliente, async (req: AuthRequest, res) => {
  const { endereco, formaPagamento, observacoes, cardPayment } = req.body || {};

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

  const cfg = await getConfigMap();
  const adminPixKey = String(cfg.pix_key || '').trim();
  const adminPixKeyType = String(cfg.pix_key_type || 'CPF').trim();
  const adminPixRecipient = String(cfg.pix_recipient_name || 'Agro Marconato Agropecuária').trim();

  if (formaPagamento === 'PIX' && !adminPixKey) {
    return res.status(400).json({
      error: 'Chave Pix de recebimento ainda não cadastrada pelo administrador (/admin > Configurações).',
    });
  }

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
    const [firstName, ...restName] = cliente.nome_completo.split(' ');
    const lastName = restName.join(' ') || firstName;

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
          email: cliente.email,
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
});

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
    if (!b.categoria_id || !b.nome || !b.descricao_completa || !b.observacao_curta || b.preco_centavos === undefined) {
      return res.status(400).json({ error: 'Preencha todos os campos obrigatórios do produto.' });
    }
    const created = await createProduto(b);
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
  const { nome_completo, cpf: rawCpf, email: rawEmail, telefone: rawTel, senha } = req.body || {};
  const cpf = cleanDigits(String(rawCpf || ''));
  const email = String(rawEmail || '').trim().toLowerCase();
  const telefone = cleanDigits(String(rawTel || ''));

  if (!nome_completo || !isValidCPF(cpf) || !isValidEmail(email) || !isValidBrazilPhone(telefone)) {
    return res.status(400).json({ error: 'Dados inválidos para cadastro de cliente.' });
  }
  const pw = validatePasswordStrength(String(senha || 'Agro@2026!Cliente'));
  if (!pw.valid) return res.status(400).json({ error: pw.errors[0] });

  const dup = await findUserByCpfOrEmail(cpf, email);
  if (dup.cpfExists || dup.emailExists) return res.status(409).json({ error: 'CPF ou e-mail já cadastrado.' });

  const created = await createCliente({
    nome_completo: String(nome_completo).trim(),
    cpf,
    email,
    telefone,
    senha_hash: bcrypt.hashSync(String(senha || 'Agro@2026!Cliente'), 10),
    identidade_verificada: false,
  });
  res.status(201).json(created);
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
