import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from './db.ts';
import { ADMIN_MASTER_CPF, getSupabaseAdmin } from './supabase.ts';
import { getConfigMap, getOrCreateCart, getProdutoById, registerUserByCpfPassword } from './store-repo.ts';
import { cleanDigits } from './utils.ts';

function boolNum(val: any): number {
  return val === true || val === 1 ? 1 : 0;
}

export async function listEnderecosByCliente(clienteId: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data } = await sb
      .from('enderecos')
      .select('*')
      .eq('cliente_id', clienteId)
      .order('padrao', { ascending: false })
      .order('criado_em', { ascending: false });
    return data || [];
  }
  return db
    .prepare(`SELECT * FROM enderecos WHERE cliente_id = ? ORDER BY padrao DESC, criado_em DESC`)
    .all(clienteId);
}

export async function createEndereco(clienteId: string, addr: any) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data, error } = await sb
      .from('enderecos')
      .insert({
        cliente_id: clienteId,
        cep: addr.cep,
        rua: addr.rua,
        numero: addr.numero,
        complemento: addr.complemento || '',
        bairro: addr.bairro,
        cidade: addr.cidade,
        estado: addr.estado,
        padrao: true,
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO enderecos (id, cliente_id, cep, rua, numero, complemento, bairro, cidade, estado, padrao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, clienteId, addr.cep, addr.rua, addr.numero, addr.complemento || '', addr.bairro, addr.cidade, addr.estado);
  return { id, ...addr };
}

export async function addOrMergeCartItem(
  clienteId: string,
  produto: any,
  modoCompra: string,
  calc: {
    quantidade: number;
    valorDesejadoCentavos: number | null;
    precoUnitarioSnapshot: number;
    subtotalCentavos: number;
  },
  computeFn: (p: any, mode: string, qtd?: number, val?: number) => any
) {
  const carrinhoId = await getOrCreateCart(clienteId);
  const sb = getSupabaseAdmin();

  if (sb) {
    const { data: existing } = await sb
      .from('itens_carrinho')
      .select('*')
      .eq('carrinho_id', carrinhoId)
      .eq('produto_id', produto.id)
      .eq('modo_compra', modoCompra)
      .maybeSingle();

    if (existing) {
      const nextQtd = Number(existing.quantidade) + calc.quantidade;
      const merged = computeFn(produto, modoCompra, nextQtd);
      await sb
        .from('itens_carrinho')
        .update({
          quantidade: merged.quantidade,
          preco_unitario_snapshot_centavos: merged.precoUnitarioSnapshot,
          subtotal_centavos: merged.subtotalCentavos,
          atualizado_em: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      await sb.from('itens_carrinho').insert({
        carrinho_id: carrinhoId,
        produto_id: produto.id,
        modo_compra: modoCompra,
        quantidade: calc.quantidade,
        preco_unitario_snapshot_centavos: calc.precoUnitarioSnapshot,
        subtotal_centavos: calc.subtotalCentavos,
      });
    }
    await sb.from('carrinhos').update({ atualizado_em: new Date().toISOString() }).eq('id', carrinhoId);
    return;
  }

  const existing = db
    .prepare(`SELECT * FROM itens_carrinho WHERE carrinho_id = ? AND produto_id = ? AND modo_compra = ?`)
    .get(carrinhoId, produto.id, modoCompra) as any;

  if (existing) {
    const nextQtd = existing.quantidade + calc.quantidade;
    const merged = computeFn(produto, modoCompra, nextQtd);
    db.prepare(`
      UPDATE itens_carrinho
      SET quantidade = ?, valor_desejado_centavos = NULL, preco_unitario_snapshot_centavos = ?, subtotal_centavos = ?, atualizado_em = datetime('now')
      WHERE id = ?
    `).run(merged.quantidade, merged.precoUnitarioSnapshot, merged.subtotalCentavos, existing.id);
  } else {
    db.prepare(`
      INSERT INTO itens_carrinho (id, carrinho_id, produto_id, modo_compra, quantidade, valor_desejado_centavos, preco_unitario_snapshot_centavos, subtotal_centavos)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      crypto.randomUUID(),
      carrinhoId,
      produto.id,
      modoCompra,
      calc.quantidade,
      calc.precoUnitarioSnapshot,
      calc.subtotalCentavos
    );
  }
  db.prepare(`UPDATE carrinhos SET atualizado_em = datetime('now') WHERE id = ?`).run(carrinhoId);
}

export async function updateCartItemRepo(
  clienteId: string,
  itemId: string,
  body: any,
  computeFn: (p: any, mode: string, qtd?: number, val?: number) => any
) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: cartRow } = await sb.from('carrinhos').select('id').eq('cliente_id', clienteId).maybeSingle();
    if (!cartRow) throw new Error('Carrinho não encontrado.');
    const { data: item } = await sb
      .from('itens_carrinho')
      .select('*')
      .eq('id', itemId)
      .eq('carrinho_id', cartRow.id)
      .maybeSingle();
    if (!item) throw new Error('Item não encontrado no carrinho.');
    const produto = await getProdutoById(item.produto_id);
    if (!produto || produto.situacao !== 'DISPONIVEL') throw new Error('Produto indisponível.');

    const modoCompra = produto.unit_type === 'kg' ? 'PESO_KG' : 'UNIDADE';
    const calc = computeFn(produto, modoCompra, body?.quantidade);
    await sb
      .from('itens_carrinho')
      .update({
        modo_compra: modoCompra,
        quantidade: calc.quantidade,
        preco_unitario_snapshot_centavos: calc.precoUnitarioSnapshot,
        subtotal_centavos: calc.subtotalCentavos,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', item.id);
    return;
  }

  const cartRow = db.prepare(`SELECT id FROM carrinhos WHERE cliente_id = ?`).get(clienteId) as { id: string } | undefined;
  if (!cartRow) throw new Error('Carrinho não encontrado.');
  const item = db.prepare(`SELECT * FROM itens_carrinho WHERE id = ? AND carrinho_id = ?`).get(itemId, cartRow.id) as any;
  if (!item) throw new Error('Item não encontrado no carrinho.');
  const produto = await getProdutoById(item.produto_id);
  if (!produto || produto.situacao !== 'DISPONIVEL') throw new Error('Produto indisponível.');

  const modoCompra = produto.unit_type === 'kg' ? 'PESO_KG' : 'UNIDADE';
  const calc = computeFn(produto, modoCompra, body?.quantidade);
  db.prepare(`
    UPDATE itens_carrinho
    SET modo_compra = ?, quantidade = ?, valor_desejado_centavos = NULL, preco_unitario_snapshot_centavos = ?, subtotal_centavos = ?, atualizado_em = datetime('now')
    WHERE id = ?
  `).run(modoCompra, calc.quantidade, calc.precoUnitarioSnapshot, calc.subtotalCentavos, item.id);
}

export async function removeCartItemRepo(clienteId: string, itemId: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: cartRow } = await sb.from('carrinhos').select('id').eq('cliente_id', clienteId).maybeSingle();
    if (!cartRow) return;
    await sb.from('itens_carrinho').delete().eq('id', itemId).eq('carrinho_id', cartRow.id);
    return;
  }
  const cartRow = db.prepare(`SELECT id FROM carrinhos WHERE cliente_id = ?`).get(clienteId) as { id: string } | undefined;
  if (!cartRow) return;
  db.prepare(`DELETE FROM itens_carrinho WHERE id = ? AND carrinho_id = ?`).run(itemId, cartRow.id);
}

// ==============================================================================
// ORDERS & PAYMENTS (Mandatory R$ 4,99 shipping + Real Supabase orders table)
// ==============================================================================

function mapSupabaseOrderRow(o: any) {
  const financeStatus =
    o.status === 'approved'
      ? 'PAGO'
      : o.status === 'rejected'
      ? 'RECUSADO'
      : o.status === 'cancelled'
      ? 'CANCELADO'
      : o.status === 'refunded'
      ? 'ESTORNADO'
      : 'AGUARDANDO_PAGAMENTO';

  const paymentStatus =
    o.status === 'approved'
      ? 'APROVADO'
      : o.status === 'rejected'
      ? 'RECUSADO'
      : o.status === 'cancelled'
      ? 'CANCELADO'
      : o.status === 'refunded'
      ? 'ESTORNADO'
      : 'PENDENTE';

  const formaPagamento =
    o.payment_method === 'credit_card'
      ? 'CARTAO_CREDITO'
      : o.payment_method === 'cash_on_delivery'
      ? 'DINHEIRO_NA_ENTREGA'
      : 'PIX';

  const addr = o.shipping_address || {};
  const rawItems = Array.isArray(o.items) ? o.items : [];
  const itens = rawItems.map((it: any, idx: number) => ({
    id: it.id || `${o.id}-item-${idx}`,
    pedido_id: o.id,
    produto_id: it.product_id || it.produto_id,
    nome_produto_snapshot: it.name || it.nome_produto_snapshot || 'Produto',
    observacao_snapshot: it.short_description || '',
    unidade_snapshot: (it.unit_type || 'un').toUpperCase(),
    unit_type: it.unit_type === 'kg' ? 'kg' : 'un',
    modo_compra: it.unit_type === 'kg' ? 'PESO_KG' : 'UNIDADE',
    quantidade: Number(it.quantity ?? it.quantidade ?? 0),
    valor_desejado_centavos: null,
    preco_unitario_snapshot_centavos: Math.round(Number(it.unit_price ?? 0) * 100),
    subtotal_centavos: Math.round(Number(it.subtotal ?? 0) * 100),
  }));

  const totalCentavos = Math.round(Number(o.total_amount || 0) * 100);
  const pagamentos = [
    {
      id: `${o.id}-pay`,
      pedido_id: o.id,
      provedor: formaPagamento === 'DINHEIRO_NA_ENTREGA' ? 'LOJA_ENTREGA' : 'MERCADO_PAGO',
      external_id: o.payment_id || null,
      forma_pagamento: formaPagamento,
      valor_centavos: totalCentavos,
      parcelas: 1,
      status: paymentStatus,
      pix_qr_code: o.pix_qr_code || null,
      pix_qr_code_base64: o.pix_qr_code_base64 || null,
      criado_em: o.created_at,
      atualizado_em: o.updated_at,
    },
  ];

  return {
    id: o.id,
    numero_pedido: o.order_number,
    cliente_id: o.user_id,
    cliente_nome: o.cliente_nome || addr.nome_destinatario || `Cliente ${String(o.cliente_cpf || '').slice(-4)}`,
    cliente_cpf: o.cliente_cpf || '',
    cliente_telefone: o.cliente_telefone || addr.telefone_contato || '',
    cliente_email: addr.email_comprovante || '',
    endereco_cep: addr.cep || '',
    endereco_rua: addr.rua || '',
    endereco_numero: addr.numero || '',
    endereco_complemento: addr.complemento || '',
    endereco_bairro: addr.bairro || '',
    endereco_cidade: addr.cidade || '',
    endereco_estado: addr.estado || '',
    subtotal_centavos: Math.round(Number(o.subtotal || 0) * 100),
    frete_centavos: Math.round(Number(o.shipping_fee ?? 4.99) * 100),
    total_centavos: totalCentavos,
    forma_pagamento: formaPagamento,
    parcelas: 1,
    situacao_financeira: financeStatus,
    situacao_entrega: o.delivery_status || 'CONFIRMADO',
    observacoes_cliente: o.notes || '',
    criado_em: o.created_at,
    atualizado_em: o.updated_at,
    itens,
    pagamentos,
    historico: Array.isArray(o.history) ? o.history : [],
  };
}

export async function createOrderFromCartRepo(params: {
  cliente: any;
  endereco: any;
  cep: string;
  formaPagamento: string;
  numParcelas: number;
  observacoes: string;
  computeFn: (p: any, mode: string, qtd?: number, val?: number) => any;
  directItems?: Array<{ produtoId: string; modoCompra?: string; quantidade: number }>;
}) {
  const { cliente, endereco, cep, formaPagamento, observacoes, computeFn, directItems } = params;
  const cfg = await getConfigMap();
  const freteCentavos = 499; // Mandatory R$ 4,99 shipping fee
  const sb = getSupabaseAdmin();

  const recipientName = String(endereco?.nome_destinatario || cliente.nome_completo || '').trim();
  const recipientPhone = String(endereco?.telefone_contato || cliente.telefone || '').trim();

  if (sb) {
    const { data: cart } = await sb.from('carrinhos').select('id').eq('cliente_id', cliente.id).maybeSingle();
    let sourceItems: any[] = [];

    if (cart) {
      const { data: cartItems } = await sb.from('itens_carrinho').select('*').eq('carrinho_id', cart.id);
      if (cartItems && cartItems.length > 0) sourceItems = cartItems;
    }

    if (sourceItems.length === 0 && directItems && directItems.length > 0) {
      sourceItems = directItems.map((d) => ({
        produto_id: d.produtoId,
        modo_compra: d.modoCompra,
        quantidade: d.quantidade,
      }));
    }

    if (sourceItems.length === 0) throw new Error('Seu carrinho está vazio.');

    let subtotalCentavos = 0;
    const orderItemsJson: any[] = [];

    for (const item of sourceItems) {
      const prod = await getProdutoById(item.produto_id);
      if (!prod || prod.situacao !== 'DISPONIVEL') {
        throw new Error(`O produto "${prod?.nome || 'selecionado'}" não está disponível para venda.`);
      }
      const mode = prod.unit_type === 'kg' ? 'PESO_KG' : 'UNIDADE';
      const calc = computeFn(prod, mode, Number(item.quantidade));

      const { error: rpcErr } = await sb.rpc('decrement_product_stock', {
        p_product_id: prod.id,
        p_quantity: calc.quantidade,
      });
      if (rpcErr) {
        throw new Error(rpcErr.message || `Estoque insuficiente para "${prod.nome}".`);
      }

      subtotalCentavos += calc.subtotalCentavos;
      orderItemsJson.push({
        product_id: prod.id,
        name: prod.nome,
        short_description: prod.observacao_curta,
        unit_type: prod.unit_type,
        quantity: calc.quantidade,
        unit_price: Number((calc.precoUnitarioSnapshot / 100).toFixed(2)),
        subtotal: Number((calc.subtotalCentavos / 100).toFixed(2)),
      });
    }

    const totalCentavos = subtotalCentavos + freteCentavos;
    const orderId = crypto.randomUUID();
    const pm =
      formaPagamento === 'CARTAO_CREDITO'
        ? 'credit_card'
        : formaPagamento === 'DINHEIRO_NA_ENTREGA'
        ? 'cash_on_delivery'
        : 'pix';

    const historyEntry = {
      id: crypto.randomUUID(),
      pedido_id: orderId,
      tipo_evento: 'CRIACAO',
      status_anterior: null,
      status_novo: 'CONFIRMADO',
      descricao: 'Pedido registrado na loja Agro Marconato.',
      autor_papel: 'CLIENTE',
      criado_em: new Date().toISOString(),
    };

    const { data: createdOrder, error: ordErr } = await sb
      .from('orders')
      .insert({
        id: orderId,
        user_id: cliente.id,
        cliente_cpf: cliente.cpf,
        cliente_nome: recipientName || cliente.nome_completo,
        cliente_telefone: recipientPhone,
        items: orderItemsJson,
        subtotal: Number((subtotalCentavos / 100).toFixed(2)),
        shipping_fee: 4.99,
        total_amount: Number((totalCentavos / 100).toFixed(2)),
        payment_method: pm,
        status: 'pending',
        delivery_status: 'CONFIRMADO',
        shipping_address: {
          nome_destinatario: recipientName,
          telefone_contato: recipientPhone,
          email_comprovante: endereco.email_comprovante || '',
          cep,
          rua: String(endereco.rua).trim(),
          numero: String(endereco.numero).trim(),
          complemento: String(endereco.complemento || '').trim(),
          bairro: String(endereco.bairro).trim(),
          cidade: String(endereco.cidade).trim(),
          estado: String(endereco.estado).trim().toUpperCase(),
        },
        notes: observacoes,
        external_reference: orderId,
        pix_key_used: cfg.pix_key || null,
        pix_key_type: cfg.pix_key_type || 'CPF',
        history: [historyEntry],
      })
      .select('*')
      .single();

    if (ordErr) throw new Error(ordErr.message);

    await sb.from('enderecos').insert({
      cliente_id: cliente.id,
      cep,
      rua: String(endereco.rua).trim(),
      numero: String(endereco.numero).trim(),
      complemento: String(endereco.complemento || '').trim(),
      bairro: String(endereco.bairro).trim(),
      cidade: String(endereco.cidade).trim(),
      estado: String(endereco.estado).trim().toUpperCase(),
      padrao: true,
    });

    if (cart) {
      await sb.from('itens_carrinho').delete().eq('carrinho_id', cart.id);
    }

    return {
      id: createdOrder.id,
      numero_pedido: createdOrder.order_number,
      subtotal_centavos: subtotalCentavos,
      frete_centavos: freteCentavos,
      total_centavos: totalCentavos,
    };
  }

  // SQLite ACID Transaction fallback
  const createOrderTx = db.transaction(() => {
    const cart = db.prepare(`SELECT id FROM carrinhos WHERE cliente_id = ?`).get(cliente.id) as { id: string } | undefined;
    let sourceItems = cart ? (db.prepare(`SELECT * FROM itens_carrinho WHERE carrinho_id = ?`).all(cart.id) as any[]) : [];

    if (sourceItems.length === 0 && directItems && directItems.length > 0) {
      sourceItems = directItems.map((d) => ({
        produto_id: d.produtoId,
        modo_compra: d.modoCompra,
        quantidade: d.quantidade,
      }));
    }

    if (sourceItems.length === 0) throw new Error('Seu carrinho está vazio.');

    let subtotalCentavos = 0;
    const orderItems: any[] = [];

    for (const item of sourceItems) {
      const prod = db.prepare(`SELECT * FROM produtos WHERE id = ?`).get(item.produto_id) as any;
      if (!prod || prod.situacao !== 'DISPONIVEL') {
        throw new Error(`O produto "${prod?.nome || 'selecionado'}" não está disponível para venda.`);
      }
      const mode = prod.modalidade_venda === 'PESO_KG' ? 'PESO_KG' : 'UNIDADE';
      const calc = computeFn(prod, mode, item.quantidade);
      if (calc.quantidade > prod.estoque_quantidade) {
        throw new Error(`Estoque insuficiente para "${prod.nome}". Disponível: ${prod.estoque_quantidade} ${prod.unidade_venda}.`);
      }
      const newStock = Number((prod.estoque_quantidade - calc.quantidade).toFixed(3));
      const newSituacao = newStock <= 0 ? 'ESGOTADO' : 'DISPONIVEL';
      const stockUpdate = db
        .prepare(`UPDATE produtos SET estoque_quantidade = ?, situacao = ?, atualizado_em = datetime('now') WHERE id = ? AND estoque_quantidade >= ?`)
        .run(Math.max(0, newStock), newSituacao, prod.id, calc.quantidade);
      if (stockUpdate.changes === 0) throw new Error(`Concorrência de estoque detectada para "${prod.nome}".`);

      subtotalCentavos += calc.subtotalCentavos;
      orderItems.push({
        id: crypto.randomUUID(),
        produto_id: prod.id,
        nome_produto_snapshot: prod.nome,
        observacao_snapshot: prod.observacao_curta,
        unidade_snapshot: mode === 'PESO_KG' ? 'KG' : 'UN',
        modo_compra: mode,
        quantidade: calc.quantidade,
        valor_desejado_centavos: null,
        preco_unitario_snapshot_centavos: calc.precoUnitarioSnapshot,
        subtotal_centavos: calc.subtotalCentavos,
      });
    }

    const maxNumRow = db.prepare(`SELECT MAX(numero_pedido) as max_num FROM pedidos`).get() as { max_num: number | null };
    const numeroPedido = (maxNumRow?.max_num || 1000) + 1;
    const pedidoId = crypto.randomUUID();
    const totalCentavos = subtotalCentavos + freteCentavos;

    db.prepare(`
      INSERT INTO pedidos (
        id, numero_pedido, cliente_id, endereco_cep, endereco_rua, endereco_numero,
        endereco_complemento, endereco_bairro, endereco_cidade, endereco_estado,
        subtotal_centavos, frete_centavos, total_centavos, forma_pagamento, parcelas,
        situacao_financeira, situacao_entrega, observacoes_cliente
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'AGUARDANDO_PAGAMENTO', 'CONFIRMADO', ?)
    `).run(
      pedidoId, numeroPedido, cliente.id, cep, String(endereco.rua).trim(), String(endereco.numero).trim(),
      String(endereco.complemento || '').trim(), String(endereco.bairro).trim(), String(endereco.cidade).trim(),
      String(endereco.estado).trim().toUpperCase(), subtotalCentavos, freteCentavos, totalCentavos,
      formaPagamento, observacoes
    );

    const insertOrderItem = db.prepare(`
      INSERT INTO itens_pedido (
        id, pedido_id, produto_id, nome_produto_snapshot, observacao_snapshot,
        unidade_snapshot, modo_compra, quantidade, valor_desejado_centavos,
        preco_unitario_snapshot_centavos, subtotal_centavos
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `);
    for (const oi of orderItems) {
      insertOrderItem.run(
        oi.id, pedidoId, oi.produto_id, oi.nome_produto_snapshot, oi.observacao_snapshot,
        oi.unidade_snapshot, oi.modo_compra, oi.quantidade,
        oi.preco_unitario_snapshot_centavos, oi.subtotal_centavos
      );
    }

    db.prepare(`
      INSERT INTO historico_pedidos (id, pedido_id, tipo_evento, status_anterior, status_novo, descricao, autor_id, autor_papel)
      VALUES (?, ?, 'CRIACAO', NULL, 'CONFIRMADO', 'Pedido registrado na loja Agro Marconato.', ?, 'CLIENTE')
    `).run(crypto.randomUUID(), pedidoId, cliente.id);

    db.prepare(`
      INSERT INTO enderecos (id, cliente_id, cep, rua, numero, complemento, bairro, cidade, estado, padrao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      crypto.randomUUID(), cliente.id, cep, String(endereco.rua).trim(), String(endereco.numero).trim(),
      String(endereco.complemento || '').trim(), String(endereco.bairro).trim(), String(endereco.cidade).trim(),
      String(endereco.estado).trim().toUpperCase()
    );

    if (cart) db.prepare(`DELETE FROM itens_carrinho WHERE carrinho_id = ?`).run(cart.id);

    return { id: pedidoId, numero_pedido: numeroPedido, subtotal_centavos: subtotalCentavos, frete_centavos: freteCentavos, total_centavos: totalCentavos };
  });

  return createOrderTx();
}

export async function saveOrderPaymentRepo(input: {
  pedido_id: string;
  provedor: string;
  external_id?: string | null;
  idempotency_key: string;
  forma_pagamento: string;
  valor_centavos: number;
  parcelas: number;
  status: string;
  pix_qr_code?: string | null;
  pix_qr_code_base64?: string | null;
  payload_bruto?: any;
  newOrderFinanceStatus?: string;
  historyDesc?: string;
}) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const mappedOrdersStatus =
      input.newOrderFinanceStatus === 'PAGO'
        ? 'approved'
        : input.newOrderFinanceStatus === 'RECUSADO'
        ? 'rejected'
        : input.newOrderFinanceStatus === 'CANCELADO'
        ? 'cancelled'
        : input.newOrderFinanceStatus === 'ESTORNADO'
        ? 'refunded'
        : 'pending';

    const { data: currentOrder } = await sb.from('orders').select('history').eq('id', input.pedido_id).maybeSingle();
    const nextHistory = Array.isArray(currentOrder?.history) ? [...currentOrder.history] : [];
    if (input.newOrderFinanceStatus && input.newOrderFinanceStatus !== 'AGUARDANDO_PAGAMENTO') {
      nextHistory.push({
        id: crypto.randomUUID(),
        pedido_id: input.pedido_id,
        tipo_evento: 'PAGAMENTO',
        status_anterior: 'AGUARDANDO_PAGAMENTO',
        status_novo: input.newOrderFinanceStatus,
        descricao: input.historyDesc || 'Pagamento processado.',
        autor_papel: 'SISTEMA',
        criado_em: new Date().toISOString(),
      });
    }

    await sb
      .from('orders')
      .update({
        payment_id: input.external_id || null,
        status: mappedOrdersStatus,
        pix_qr_code: input.pix_qr_code || null,
        pix_qr_code_base64: input.pix_qr_code_base64 || null,
        history: nextHistory,
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.pedido_id);

    return {
      id: `${input.pedido_id}-pay`,
      pedido_id: input.pedido_id,
      provedor: input.provedor,
      external_id: input.external_id || null,
      forma_pagamento: input.forma_pagamento,
      valor_centavos: input.valor_centavos,
      parcelas: 1,
      status: input.status,
      pix_qr_code: input.pix_qr_code || null,
      pix_qr_code_base64: input.pix_qr_code_base64 || null,
    };
  }

  const paymentId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO pagamentos (id, pedido_id, provedor, external_id, idempotency_key, forma_pagamento, valor_centavos, parcelas, status, pix_qr_code, pix_qr_code_base64, payload_bruto)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    paymentId,
    input.pedido_id,
    input.provedor,
    input.external_id || null,
    input.idempotency_key,
    input.forma_pagamento,
    input.valor_centavos,
    input.status,
    input.pix_qr_code || null,
    input.pix_qr_code_base64 || null,
    input.payload_bruto ? JSON.stringify(input.payload_bruto) : null
  );

  if (input.newOrderFinanceStatus && input.newOrderFinanceStatus !== 'AGUARDANDO_PAGAMENTO') {
    db.prepare(`UPDATE pedidos SET situacao_financeira = ?, atualizado_em = datetime('now') WHERE id = ?`).run(
      input.newOrderFinanceStatus,
      input.pedido_id
    );
    db.prepare(`
      INSERT INTO historico_pedidos (id, pedido_id, tipo_evento, status_anterior, status_novo, descricao, autor_papel)
      VALUES (?, ?, 'PAGAMENTO', 'AGUARDANDO_PAGAMENTO', ?, ?, 'SISTEMA')
    `).run(crypto.randomUUID(), input.pedido_id, input.newOrderFinanceStatus, input.historyDesc || 'Pagamento processado.');
  }
  return db.prepare(`SELECT * FROM pagamentos WHERE id = ?`).get(paymentId);
}

export async function getOrderByIdRepo(pedidoId: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: order } = await sb.from('orders').select('*').eq('id', pedidoId).maybeSingle();
    if (!order) return null;
    return mapSupabaseOrderRow(order);
  }

  const pedido = db
    .prepare(`
      SELECT p.*, c.nome_completo as cliente_nome, c.cpf as cliente_cpf, c.telefone as cliente_telefone, c.email as cliente_email
      FROM pedidos p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?
    `)
    .get(pedidoId) as any;
  if (!pedido) return null;

  const itens = db.prepare(`SELECT * FROM itens_pedido WHERE pedido_id = ?`).all(pedidoId) as any[];
  const pagamentos = db
    .prepare(`SELECT id, pedido_id, provedor, external_id, forma_pagamento, valor_centavos, parcelas, status, pix_qr_code, pix_qr_code_base64, criado_em, atualizado_em FROM pagamentos WHERE pedido_id = ? ORDER BY criado_em DESC`)
    .all(pedidoId);
  const historico = db.prepare(`SELECT * FROM historico_pedidos WHERE pedido_id = ? ORDER BY criado_em ASC`).all(pedidoId);
  return {
    ...pedido,
    itens: itens.map((it) => ({ ...it, unit_type: it.modo_compra === 'PESO_KG' ? 'kg' : 'un' })),
    pagamentos,
    historico,
  };
}

export async function listOrdersRepo(clienteId?: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    let q = sb.from('orders').select('*').order('created_at', { ascending: false });
    if (clienteId) q = q.eq('user_id', clienteId);
    const { data } = await q;
    return (data || []).map(mapSupabaseOrderRow);
  }
  const rows = clienteId
    ? (db.prepare(`SELECT id FROM pedidos WHERE cliente_id = ? ORDER BY criado_em DESC`).all(clienteId) as { id: string }[])
    : (db.prepare(`SELECT id FROM pedidos ORDER BY criado_em DESC`).all() as { id: string }[]);
  const results = await Promise.all(rows.map((r) => getOrderByIdRepo(r.id)));
  return results.filter(Boolean);
}

export async function isWebhookProcessedRepo(eventoChave: string): Promise<boolean> {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data } = await sb.from('webhooks_processados').select('id').eq('evento_chave', eventoChave).maybeSingle();
    return Boolean(data);
  }
  const row = db.prepare(`SELECT id FROM webhooks_processados WHERE evento_chave = ?`).get(eventoChave);
  return Boolean(row);
}

export async function markWebhookProcessedRepo(eventoChave: string, paymentId: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    await sb.from('webhooks_processados').upsert({ evento_chave: eventoChave, payment_id: paymentId }, { onConflict: 'evento_chave' });
    return;
  }
  db.prepare(`INSERT OR IGNORE INTO webhooks_processados (id, evento_chave, payment_id) VALUES (?, ?, ?)`).run(
    crypto.randomUUID(),
    eventoChave,
    paymentId
  );
}

export async function applyPaymentStatusRepo(
  externalId: string,
  pedidoIdRef: string,
  amountCentavos: number,
  paymentStatus: string,
  orderFinanceStatus: string,
  mpStatus: string,
  _source: string
) {
  const sb = getSupabaseAdmin();
  if (sb) {
    let { data: order } = await sb
      .from('orders')
      .select('*')
      .eq('external_reference', pedidoIdRef || externalId)
      .maybeSingle();

    if (!order && externalId) {
      const alt = await sb.from('orders').select('*').eq('payment_id', externalId).maybeSingle();
      order = alt.data;
    }
    if (!order) return null;

    const totalCent = Math.round(Number(order.total_amount || 0) * 100);
    if (amountCentavos > 0 && Math.abs(amountCentavos - totalCent) > 2) return null;

    const mappedOrdersStatus =
      orderFinanceStatus === 'PAGO'
        ? 'approved'
        : orderFinanceStatus === 'RECUSADO'
        ? 'rejected'
        : orderFinanceStatus === 'CANCELADO'
        ? 'cancelled'
        : orderFinanceStatus === 'ESTORNADO'
        ? 'refunded'
        : 'pending';

    const history = Array.isArray(order.history) ? [...order.history] : [];
    if (order.status !== mappedOrdersStatus) {
      history.push({
        id: crypto.randomUUID(),
        pedido_id: order.id,
        tipo_evento: 'PAGAMENTO_WEBHOOK',
        status_anterior: order.status,
        status_novo: orderFinanceStatus,
        descricao: `Status financeiro confirmado via Mercado Pago (${mpStatus}).`,
        autor_papel: 'SISTEMA',
        criado_em: new Date().toISOString(),
      });
    }

    await sb
      .from('orders')
      .update({
        status: mappedOrdersStatus,
        payment_id: externalId,
        history,
        updated_at: new Date().toISOString(),
      })
      .eq('id', order.id);

    return { pedidoId: order.id, clienteId: order.user_id };
  }

  const paymentRow = db
    .prepare(`SELECT * FROM pagamentos WHERE external_id = ? OR pedido_id = ? ORDER BY criado_em DESC LIMIT 1`)
    .get(externalId, pedidoIdRef) as any;
  if (!paymentRow) return null;
  const pedido = db.prepare(`SELECT * FROM pedidos WHERE id = ?`).get(paymentRow.pedido_id) as any;
  if (!pedido) return null;
  if (pedidoIdRef && pedidoIdRef !== pedido.id) return null;
  if (amountCentavos > 0 && Math.abs(amountCentavos - pedido.total_centavos) > 2) return null;

  db.transaction(() => {
    db.prepare(`UPDATE pagamentos SET status = ?, payload_bruto = ?, atualizado_em = datetime('now') WHERE id = ?`).run(
      paymentStatus,
      JSON.stringify({ id: externalId, status: mpStatus }),
      paymentRow.id
    );
    if (pedido.situacao_financeira !== orderFinanceStatus) {
      db.prepare(`UPDATE pedidos SET situacao_financeira = ?, atualizado_em = datetime('now') WHERE id = ?`).run(
        orderFinanceStatus,
        pedido.id
      );
      db.prepare(`
        INSERT INTO historico_pedidos (id, pedido_id, tipo_evento, status_anterior, status_novo, descricao, autor_papel)
        VALUES (?, ?, 'PAGAMENTO_WEBHOOK', ?, ?, ?, 'SISTEMA')
      `).run(
        crypto.randomUUID(),
        pedido.id,
        pedido.situacao_financeira,
        orderFinanceStatus,
        `Status financeiro confirmado via Mercado Pago (${mpStatus}).`
      );
    }
  })();

  return { pedidoId: pedido.id, clienteId: pedido.cliente_id };
}

export async function updateOrderDeliveryStatusRepo(pedidoId: string, situacaoEntrega: string, observacao: string | undefined, adminId: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: order } = await sb.from('orders').select('*').eq('id', pedidoId).maybeSingle();
    if (!order) return null;
    const history = Array.isArray(order.history) ? [...order.history] : [];
    history.push({
      id: crypto.randomUUID(),
      pedido_id: pedidoId,
      tipo_evento: 'ENTREGA',
      status_anterior: order.delivery_status,
      status_novo: situacaoEntrega,
      descricao: observacao || `Status de entrega atualizado para ${situacaoEntrega}.`,
      autor_id: adminId,
      autor_papel: 'ADMIN',
      criado_em: new Date().toISOString(),
    });
    await sb
      .from('orders')
      .update({ delivery_status: situacaoEntrega, history, updated_at: new Date().toISOString() })
      .eq('id', pedidoId);
    return order.user_id;
  }

  const pedido = db.prepare(`SELECT * FROM pedidos WHERE id = ?`).get(pedidoId) as any;
  if (!pedido) return null;
  db.prepare(`UPDATE pedidos SET situacao_entrega = ?, atualizado_em = datetime('now') WHERE id = ?`).run(situacaoEntrega, pedidoId);
  db.prepare(`
    INSERT INTO historico_pedidos (id, pedido_id, tipo_evento, status_anterior, status_novo, descricao, autor_id, autor_papel)
    VALUES (?, ?, 'ENTREGA', ?, ?, ?, ?, 'ADMIN')
  `).run(
    crypto.randomUUID(),
    pedidoId,
    pedido.situacao_entrega,
    situacaoEntrega,
    observacao || `Status de entrega atualizado para ${situacaoEntrega}.`,
    adminId
  );
  return pedido.cliente_id;
}

export async function settleCashOrderRepo(pedidoId: string, adminId: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: order } = await sb.from('orders').select('*').eq('id', pedidoId).maybeSingle();
    if (!order) return { error: 'Pedido não encontrado.', status: 404 };
    if (order.payment_method !== 'cash_on_delivery') {
      return { error: 'Quitação manual permitida apenas para dinheiro na entrega.', status: 400 };
    }
    const history = Array.isArray(order.history) ? [...order.history] : [];
    history.push({
      id: crypto.randomUUID(),
      pedido_id: pedidoId,
      tipo_evento: 'QUITACAO_DINHEIRO',
      status_anterior: order.status,
      status_novo: 'PAGO',
      descricao: 'Pagamento em dinheiro na entrega confirmado pelo administrador.',
      autor_id: adminId,
      autor_papel: 'ADMIN',
      criado_em: new Date().toISOString(),
    });
    await sb.from('orders').update({ status: 'approved', history, updated_at: new Date().toISOString() }).eq('id', pedidoId);
    return { clienteId: order.user_id };
  }

  const pedido = db.prepare(`SELECT * FROM pedidos WHERE id = ?`).get(pedidoId) as any;
  if (!pedido) return { error: 'Pedido não encontrado.', status: 404 };
  if (pedido.forma_pagamento !== 'DINHEIRO_NA_ENTREGA') {
    return { error: 'Quitação manual permitida apenas para dinheiro na entrega.', status: 400 };
  }
  db.transaction(() => {
    db.prepare(`UPDATE pedidos SET situacao_financeira = 'PAGO', atualizado_em = datetime('now') WHERE id = ?`).run(pedidoId);
    db.prepare(`UPDATE pagamentos SET status = 'APROVADO', atualizado_em = datetime('now') WHERE pedido_id = ?`).run(pedidoId);
    db.prepare(`
      INSERT INTO historico_pedidos (id, pedido_id, tipo_evento, status_anterior, status_novo, descricao, autor_id, autor_papel)
      VALUES (?, ?, 'QUITACAO_DINHEIRO', ?, 'PAGO', 'Pagamento em dinheiro na entrega confirmado pelo administrador.', ?, 'ADMIN')
    `).run(crypto.randomUUID(), pedidoId, pedido.situacao_financeira, adminId);
  })();
  return { clienteId: pedido.cliente_id };
}

// ==============================================================================
// ADMIN DASHBOARD, CLIENTS & ADMINS, CONVERSATIONS
// ==============================================================================

export async function getAdminDashboardRepo() {
  const sb = getSupabaseAdmin();
  if (sb) {
    const [{ data: orders }, { data: prods }] = await Promise.all([
      sb.from('orders').select('total_amount, status, delivery_status'),
      sb.from('products').select('id, name, stock, low_stock_limit, unit_type, active'),
    ]);

    const orderList = orders || [];
    const prodList = prods || [];

    const totalVendas = orderList
      .filter((o: any) => o.status === 'approved')
      .reduce((acc: number, o: any) => acc + Math.round(Number(o.total_amount || 0) * 100), 0);

    return {
      total_vendas_centavos: totalVendas,
      quantidade_pedidos: orderList.length,
      pedidos_aguardando_pagamento: orderList.filter((o: any) => o.status === 'pending').length,
      pedidos_em_preparacao: orderList.filter((o: any) => o.delivery_status === 'EM_PREPARACAO').length,
      pedidos_enviados: orderList.filter((o: any) => o.delivery_status === 'SAIU_PARA_ENTREGA').length,
      pedidos_entregues: orderList.filter((o: any) => o.delivery_status === 'ENTREGUE').length,
      produtos_estoque_baixo: prodList
        .filter((p: any) => p.active && Number(p.stock) > 0 && Number(p.stock) <= Number(p.low_stock_limit))
        .map((p: any) => ({
          id: p.id,
          nome: p.name,
          estoque_quantidade: Number(p.stock),
          estoque_baixo_limite: Number(p.low_stock_limit),
          unidade_venda: p.unit_type === 'kg' ? 'KG' : 'UN',
          situacao: 'DISPONIVEL',
        })),
      produtos_esgotados: prodList
        .filter((p: any) => Number(p.stock) <= 0)
        .map((p: any) => ({
          id: p.id,
          nome: p.name,
          estoque_quantidade: Number(p.stock),
          unidade_venda: p.unit_type === 'kg' ? 'KG' : 'UN',
          situacao: 'ESGOTADO',
        })),
    };
  }

  const totalVendasRow = db
    .prepare(`SELECT COALESCE(SUM(total_centavos), 0) as total FROM pedidos WHERE situacao_financeira = 'PAGO'`)
    .get() as { total: number };
  const totalPedidosRow = db.prepare(`SELECT COUNT(*) as total FROM pedidos`).get() as { total: number };
  const aguardandoPagamento = db
    .prepare(`SELECT COUNT(*) as total FROM pedidos WHERE situacao_financeira = 'AGUARDANDO_PAGAMENTO'`)
    .get() as { total: number };
  const emPreparacao = db
    .prepare(`SELECT COUNT(*) as total FROM pedidos WHERE situacao_entrega = 'EM_PREPARACAO'`)
    .get() as { total: number };
  const enviados = db
    .prepare(`SELECT COUNT(*) as total FROM pedidos WHERE situacao_entrega = 'SAIU_PARA_ENTREGA'`)
    .get() as { total: number };
  const entregues = db
    .prepare(`SELECT COUNT(*) as total FROM pedidos WHERE situacao_entrega = 'ENTREGUE'`)
    .get() as { total: number };

  const estoqueBaixo = db
    .prepare(`
      SELECT id, nome, estoque_quantidade, estoque_baixo_limite, unidade_venda, situacao
      FROM produtos WHERE situacao = 'DISPONIVEL' AND estoque_quantidade > 0 AND estoque_quantidade <= estoque_baixo_limite
      ORDER BY estoque_quantidade ASC
    `)
    .all();
  const esgotados = db
    .prepare(`
      SELECT id, nome, estoque_quantidade, unidade_venda, situacao
      FROM produtos WHERE situacao = 'ESGOTADO' OR estoque_quantidade <= 0
      ORDER BY atualizado_em DESC
    `)
    .all();

  return {
    total_vendas_centavos: totalVendasRow.total,
    quantidade_pedidos: totalPedidosRow.total,
    pedidos_aguardando_pagamento: aguardandoPagamento.total,
    pedidos_em_preparacao: emPreparacao.total,
    pedidos_enviados: enviados.total,
    pedidos_entregues: entregues.total,
    produtos_estoque_baixo: estoqueBaixo,
    produtos_esgotados: esgotados,
  };
}

export async function listClientesAdminRepo() {
  const sb = getSupabaseAdmin();
  if (sb) {
    const [{ data: clis }, { data: orders }] = await Promise.all([
      sb
        .from('profiles')
        .select('id, full_name, cpf, email, phone, created_at')
        .eq('is_admin', false)
        .order('created_at', { ascending: false }),
      sb.from('orders').select('user_id'),
    ]);
    const counts = new Map<string, number>();
    for (const o of orders || []) counts.set(o.user_id, (counts.get(o.user_id) || 0) + 1);
    return (clis || []).map((c: any) => ({
      id: c.id,
      nome_completo: c.full_name,
      cpf: c.cpf,
      email: c.email,
      telefone: c.phone,
      criado_em: c.created_at,
      total_pedidos: counts.get(c.id) || 0,
    }));
  }
  return db
    .prepare(`
      SELECT c.id, c.nome_completo, c.cpf, c.email, c.telefone, c.criado_em,
             (SELECT COUNT(*) FROM pedidos p WHERE p.cliente_id = c.id) as total_pedidos
      FROM clientes c ORDER BY c.criado_em DESC
    `)
    .all();
}

export async function listAdminsRepo() {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data } = await sb
      .from('profiles')
      .select('id, full_name, cpf, email, phone, created_at')
      .eq('is_admin', true)
      .order('created_at', { ascending: false });
    return (data || []).map((a: any) => ({
      id: a.id,
      nome_completo: a.full_name,
      cpf: a.cpf,
      email: a.email,
      telefone: a.phone,
      ativo: true,
      criado_em: a.created_at,
    }));
  }
  return db
    .prepare(`SELECT id, nome_completo, cpf, email, telefone, ativo, criado_em FROM administradores ORDER BY criado_em DESC`)
    .all();
}

export async function createAdminRepo(input: {
  nome_completo: string;
  cpf: string;
  email: string;
  telefone: string;
  senha: string;
  criado_por: string;
}) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const user = await registerUserByCpfPassword({
      cpf: input.cpf,
      senha: input.senha,
      nome_completo: input.nome_completo,
      telefone: input.telefone,
    });
    await sb.from('profiles').update({ is_admin: true }).eq('id', user.id);
    return user;
  }
  const hash = bcrypt.hashSync(input.senha, 10);
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO administradores (id, nome_completo, cpf, email, telefone, senha_hash, papel, criado_por)
    VALUES (?, ?, ?, ?, ?, ?, 'ADMIN', ?)
  `).run(id, input.nome_completo, input.cpf, input.email, input.telefone, hash, input.criado_por);
  return { id, nome_completo: input.nome_completo, cpf: input.cpf, email: input.email, telefone: input.telefone };
}

export async function updateClienteAdminRepo(clienteId: string, data: { nome_completo?: string; telefone?: string; email?: string }) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: prof } = await sb.from('profiles').select('is_admin').eq('id', clienteId).maybeSingle();
    if (!prof) throw new Error('Cliente não encontrado.');
    if (prof.is_admin) throw new Error('Não é permitido alterar administradores por esta rota.');

    const updatePayload: any = {};
    if (data.nome_completo) updatePayload.full_name = String(data.nome_completo).trim();
    if (data.telefone) updatePayload.phone = cleanDigits(data.telefone);
    if (data.email) updatePayload.email = String(data.email).trim().toLowerCase();
    updatePayload.updated_at = new Date().toISOString();

    const { error } = await sb.from('profiles').update(updatePayload).eq('id', clienteId);
    if (error) throw new Error(error.message);
    return { ok: true };
  }

  const cli = db.prepare(`SELECT id FROM clientes WHERE id = ?`).get(clienteId);
  if (!cli) throw new Error('Cliente não encontrado.');
  const fields: string[] = [];
  const vals: any[] = [];
  if (data.nome_completo) {
    fields.push('nome_completo = ?');
    vals.push(String(data.nome_completo).trim());
  }
  if (data.telefone) {
    fields.push('telefone = ?');
    vals.push(cleanDigits(data.telefone));
  }
  if (data.email) {
    fields.push('email = ?');
    vals.push(String(data.email).trim().toLowerCase());
  }
  if (fields.length > 0) {
    vals.push(clienteId);
    db.prepare(`UPDATE clientes SET ${fields.join(', ')}, atualizado_em = datetime('now') WHERE id = ?`).run(...vals);
  }
  return { ok: true };
}

export async function deleteClienteAdminRepo(clienteId: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: prof } = await sb.from('profiles').select('cpf, is_admin').eq('id', clienteId).maybeSingle();
    if (!prof) throw new Error('Cliente não encontrado.');
    if (prof.is_admin || prof.cpf === ADMIN_MASTER_CPF) {
      throw new Error('Não é permitido excluir o administrador principal ou contas administrativas.');
    }
    const { error } = await sb.auth.admin.deleteUser(clienteId);
    if (error) {
      await sb.from('profiles').delete().eq('id', clienteId);
    }
    return { ok: true };
  }

  const cli = db.prepare(`SELECT cpf FROM clientes WHERE id = ?`).get(clienteId) as any;
  if (!cli) throw new Error('Cliente não encontrado.');
  if (cli.cpf === ADMIN_MASTER_CPF) throw new Error('Não é permitido excluir o administrador principal.');
  db.prepare(`DELETE FROM clientes WHERE id = ?`).run(clienteId);
  return { ok: true };
}

export async function updateAdminAdminRepo(
  adminId: string,
  operatorId: string,
  data: { nome_completo?: string; email?: string; telefone?: string; ativo?: boolean; is_admin?: boolean }
) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: prof } = await sb.from('profiles').select('cpf, is_admin').eq('id', adminId).maybeSingle();
    if (!prof) throw new Error('Administrador não encontrado.');

    if (prof.cpf === ADMIN_MASTER_CPF) {
      if (data.is_admin === false || data.ativo === false) {
        throw new Error('O administrador principal não pode ser desativado ou rebaixado.');
      }
    }

    if (adminId === operatorId && (data.is_admin === false || data.ativo === false)) {
      throw new Error('Você não pode desativar ou rebaixar a si mesmo.');
    }

    const updatePayload: any = {};
    if (data.nome_completo) updatePayload.full_name = String(data.nome_completo).trim();
    if (data.email) updatePayload.email = String(data.email).trim().toLowerCase();
    if (data.telefone) updatePayload.phone = cleanDigits(data.telefone);
    if (data.is_admin !== undefined && prof.cpf !== ADMIN_MASTER_CPF) {
      updatePayload.is_admin = Boolean(data.is_admin);
    }
    updatePayload.updated_at = new Date().toISOString();

    const { error } = await sb.from('profiles').update(updatePayload).eq('id', adminId);
    if (error) throw new Error(error.message);
    return { ok: true };
  }

  const adm = db.prepare(`SELECT cpf FROM administradores WHERE id = ?`).get(adminId) as any;
  if (!adm) throw new Error('Administrador não encontrado.');
  if (adm.cpf === ADMIN_MASTER_CPF && data.ativo === false) {
    throw new Error('O administrador principal não pode ser desativado.');
  }
  if (adminId === operatorId && data.ativo === false) {
    throw new Error('Você não pode desativar a si mesmo.');
  }
  db.prepare(`UPDATE administradores SET nome_completo = COALESCE(?, nome_completo), email = COALESCE(?, email), telefone = COALESCE(?, telefone), ativo = COALESCE(?, ativo) WHERE id = ?`).run(
    data.nome_completo || null,
    data.email || null,
    data.telefone || null,
    data.ativo !== undefined ? (data.ativo ? 1 : 0) : null,
    adminId
  );
  return { ok: true };
}

export async function deleteAdminAdminRepo(adminId: string, operatorId: string) {
  if (adminId === operatorId) {
    throw new Error('Você não pode excluir sua própria conta administrativa.');
  }
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: prof } = await sb.from('profiles').select('cpf').eq('id', adminId).maybeSingle();
    if (!prof) throw new Error('Administrador não encontrado.');
    if (prof.cpf === ADMIN_MASTER_CPF) {
      throw new Error('O administrador principal não pode ser excluído.');
    }
    const { error } = await sb.auth.admin.deleteUser(adminId);
    if (error) {
      await sb.from('profiles').delete().eq('id', adminId);
    }
    return { ok: true };
  }

  const adm = db.prepare(`SELECT cpf FROM administradores WHERE id = ?`).get(adminId) as any;
  if (!adm) throw new Error('Administrador não encontrado.');
  if (adm.cpf === ADMIN_MASTER_CPF) {
    throw new Error('O administrador principal não pode ser excluído.');
  }
  db.prepare(`DELETE FROM administradores WHERE id = ?`).run(adminId);
  return { ok: true };
}

export async function listConversationsRepo(user: { id: string; papel: 'ADMIN' | 'CLIENTE' }) {
  const sb = getSupabaseAdmin();
  if (sb) {
    let q = sb
      .from('conversas')
      .select('*, profiles(full_name, cpf, phone)')
      .order('ultima_mensagem_em', { ascending: false });
    if (user.papel === 'CLIENTE') q = q.eq('cliente_id', user.id);
    const { data: convs } = await q;
    const { data: msgs } = await sb
      .from('mensagens')
      .select('conversa_id, remetente_papel, lida, conteudo, criado_em')
      .order('criado_em', { ascending: false });

    const unreadRole = user.papel === 'ADMIN' ? 'CLIENTE' : 'ADMIN';
    return (convs || []).map((c: any) => {
      const convMsgs = (msgs || []).filter((m: any) => m.conversa_id === c.id);
      const naoLidas = convMsgs.filter((m: any) => m.remetente_papel === unreadRole && !m.lida).length;
      return {
        ...c,
        cliente_nome: c.profiles?.full_name,
        cliente_cpf: c.profiles?.cpf,
        cliente_telefone: c.profiles?.phone,
        nao_lidas: naoLidas,
        ultima_mensagem: convMsgs[0]?.conteudo || null,
      };
    });
  }

  if (user.papel === 'ADMIN') {
    return db
      .prepare(`
        SELECT cv.*, c.nome_completo as cliente_nome, c.cpf as cliente_cpf, c.telefone as cliente_telefone,
               (SELECT COUNT(*) FROM mensagens m WHERE m.conversa_id = cv.id AND m.remetente_papel = 'CLIENTE' AND m.lida = 0) as nao_lidas,
               (SELECT conteudo FROM mensagens m WHERE m.conversa_id = cv.id ORDER BY m.criado_em DESC LIMIT 1) as ultima_mensagem
        FROM conversas cv JOIN clientes c ON c.id = cv.cliente_id
        ORDER BY cv.ultima_mensagem_em DESC
      `)
      .all();
  }
  return db
    .prepare(`
      SELECT cv.*,
             (SELECT COUNT(*) FROM mensagens m WHERE m.conversa_id = cv.id AND m.remetente_papel = 'ADMIN' AND m.lida = 0) as nao_lidas,
             (SELECT conteudo FROM mensagens m WHERE m.conversa_id = cv.id ORDER BY m.criado_em DESC LIMIT 1) as ultima_mensagem
      FROM conversas cv WHERE cv.cliente_id = ? ORDER BY cv.ultima_mensagem_em DESC
    `)
    .all(user.id);
}

export async function getOrCreateConversationRepo(clienteId: string, pedidoId: string | null, assunto?: string) {
  const sb = getSupabaseAdmin();
  if (sb) {
    if (pedidoId) {
      const { data: order } = await sb
        .from('orders')
        .select('id, order_number')
        .eq('id', pedidoId)
        .eq('user_id', clienteId)
        .maybeSingle();
      if (!order) throw new Error('Pedido não encontrado.');
      const { data: existing } = await sb
        .from('conversas')
        .select('*')
        .eq('cliente_id', clienteId)
        .eq('pedido_id', pedidoId)
        .maybeSingle();
      if (existing) return existing;
      const { data: created } = await sb
        .from('conversas')
        .insert({ cliente_id: clienteId, pedido_id: pedidoId, assunto: `Dúvida sobre o Pedido #${order.order_number}` })
        .select('*')
        .single();
      return created;
    }

    const { data: existingGen } = await sb
      .from('conversas')
      .select('*')
      .eq('cliente_id', clienteId)
      .is('pedido_id', null)
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingGen) return existingGen;
    const { data: created } = await sb
      .from('conversas')
      .insert({ cliente_id: clienteId, pedido_id: null, assunto: assunto || 'Atendimento Agro Marconato' })
      .select('*')
      .single();
    return created;
  }

  if (pedidoId) {
    const pedido = db.prepare(`SELECT id, numero_pedido FROM pedidos WHERE id = ? AND cliente_id = ?`).get(pedidoId, clienteId) as any;
    if (!pedido) throw new Error('Pedido não encontrado.');
    const existing = db.prepare(`SELECT * FROM conversas WHERE cliente_id = ? AND pedido_id = ?`).get(clienteId, pedidoId);
    if (existing) return existing;
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO conversas (id, cliente_id, pedido_id, assunto) VALUES (?, ?, ?, ?)`).run(
      id, clienteId, pedidoId, `Dúvida sobre o Pedido #${pedido.numero_pedido}`
    );
    return db.prepare(`SELECT * FROM conversas WHERE id = ?`).get(id);
  }

  const existingGeneral = db
    .prepare(`SELECT * FROM conversas WHERE cliente_id = ? AND pedido_id IS NULL ORDER BY criado_em DESC LIMIT 1`)
    .get(clienteId);
  if (existingGeneral) return existingGeneral;
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO conversas (id, cliente_id, pedido_id, assunto) VALUES (?, ?, NULL, ?)`).run(
    id, clienteId, assunto || 'Atendimento Agro Marconato'
  );
  return db.prepare(`SELECT * FROM conversas WHERE id = ?`).get(id);
}

export async function getConversationMessagesRepo(conversaId: string, user: { id: string; papel: 'ADMIN' | 'CLIENTE' }) {
  const sb = getSupabaseAdmin();
  if (sb) {
    const { data: conv } = await sb.from('conversas').select('*').eq('id', conversaId).maybeSingle();
    if (!conv) return { status: 404, error: 'Conversa não encontrada.' };
    if (user.papel !== 'ADMIN' && conv.cliente_id !== user.id) return { status: 403, error: 'Acesso negado.' };
    const opposite = user.papel === 'ADMIN' ? 'CLIENTE' : 'ADMIN';
    await sb.from('mensagens').update({ lida: true }).eq('conversa_id', conv.id).eq('remetente_papel', opposite);
    const { data: msgs } = await sb.from('mensagens').select('*').eq('conversa_id', conv.id).order('criado_em', { ascending: true });
    return { messages: (msgs || []).map((m: any) => ({ ...m, lida: boolNum(m.lida) })) };
  }

  const conv = db.prepare(`SELECT * FROM conversas WHERE id = ?`).get(conversaId) as any;
  if (!conv) return { status: 404, error: 'Conversa não encontrada.' };
  if (user.papel !== 'ADMIN' && conv.cliente_id !== user.id) return { status: 403, error: 'Acesso negado.' };
  const oppositeRole = user.papel === 'ADMIN' ? 'CLIENTE' : 'ADMIN';
  db.prepare(`UPDATE mensagens SET lida = 1 WHERE conversa_id = ? AND remetente_papel = ?`).run(conv.id, oppositeRole);
  const messages = db.prepare(`SELECT * FROM mensagens WHERE conversa_id = ? ORDER BY criado_em ASC`).all(conv.id);
  return { messages };
}

export async function addConversationMessageRepo(
  conversaId: string,
  user: { id: string; papel: 'ADMIN' | 'CLIENTE'; nome: string },
  conteudo: string,
  pedidoIdOverride?: string | null
) {
  const sb = getSupabaseAdmin();
  const now = new Date().toISOString();
  if (sb) {
    const { data: conv } = await sb.from('conversas').select('*').eq('id', conversaId).maybeSingle();
    if (!conv) return { status: 404, error: 'Conversa não encontrada.' };
    if (user.papel !== 'ADMIN' && conv.cliente_id !== user.id) return { status: 403, error: 'Acesso negado.' };

    const { data: msg, error } = await sb
      .from('mensagens')
      .insert({
        conversa_id: conv.id,
        remetente_id: user.id,
        remetente_papel: user.papel,
        remetente_nome: user.nome,
        conteudo,
        pedido_id: pedidoIdOverride || conv.pedido_id || null,
        lida: false,
        criado_em: now,
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    await sb.from('conversas').update({ ultima_mensagem_em: now }).eq('id', conv.id);
    return { message: { ...msg, lida: 0 }, clienteId: conv.cliente_id };
  }

  const conv = db.prepare(`SELECT * FROM conversas WHERE id = ?`).get(conversaId) as any;
  if (!conv) return { status: 404, error: 'Conversa não encontrada.' };
  if (user.papel !== 'ADMIN' && conv.cliente_id !== user.id) return { status: 403, error: 'Acesso negado.' };
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO mensagens (id, conversa_id, remetente_id, remetente_papel, remetente_nome, conteudo, pedido_id, lida, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, conv.id, user.id, user.papel, user.nome, conteudo, pedidoIdOverride || conv.pedido_id || null, now);
  db.prepare(`UPDATE conversas SET ultima_mensagem_em = ? WHERE id = ?`).run(now, conv.id);
  const msg = db.prepare(`SELECT * FROM mensagens WHERE id = ?`).get(id);
  return { message: msg, clienteId: conv.cliente_id };
}
