import { useEffect, useState } from 'react';
import { MessageSquare, RefreshCw, Copy, Check, PackageCheck } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import {
  DELIVERY_STATUS_LABEL,
  FINANCE_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
  formatBRL,
  formatDateTimeBR,
  formatWeight,
} from '../lib/format.ts';
import type { Order, User } from '../types.ts';

interface MyOrdersPageProps {
  user: User | null;
  onOpenAuth: () => void;
  onOpenOrderChat: (pedidoId: string) => void;
}

const DELIVERY_STEPS = ['CONFIRMADO', 'EM_PREPARACAO', 'SAIU_PARA_ENTREGA', 'ENTREGUE'];

export function MyOrdersPage({ user, onOpenAuth, onOpenOrderChat }: MyOrdersPageProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  async function loadOrders() {
    if (!user || user.papel !== 'CLIENTE') {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await apiFetch<Order[]>('/api/pedidos');
      setOrders(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadOrders();
  }, [user]);

  async function verifyPayment(orderId: string) {
    setCheckingId(orderId);
    try {
      const res = await apiFetch<{ pedido: Order }>(`/api/pedidos/${orderId}/verificar-pagamento`, {
        method: 'POST',
      });
      setOrders((prev) => prev.map((o) => (o.id === orderId ? res.pedido : o)));
    } finally {
      setCheckingId(null);
    }
  }

  if (!user) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-20 text-center space-y-4">
        <PackageCheck className="w-10 h-10 text-[#143824] mx-auto" />
        <h1 className="text-2xl font-bold text-zinc-900">Meus pedidos</h1>
        <p className="text-sm text-zinc-600">
          Entre com seu CPF e senha para visualizar suas compras, pagamentos e rastreamento de entregas.
        </p>
        <button
          type="button"
          onClick={onOpenAuth}
          className="px-5 py-2.5 bg-[#143824] text-white text-sm font-semibold rounded-lg cursor-pointer"
        >
          Entrar na minha conta
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-8">
      <div className="flex items-center justify-between border-b border-zinc-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Meus pedidos</h1>
          <p className="text-sm text-zinc-600 mt-1">
            Acompanhe status de pagamento, entrega e histórico completo das suas compras.
          </p>
        </div>
        <button
          type="button"
          onClick={loadOrders}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-zinc-300 rounded-lg text-xs font-medium text-zinc-700 hover:bg-zinc-50 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Atualizar</span>
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-zinc-500">Carregando pedidos...</div>
      ) : orders.length === 0 ? (
        <div className="py-16 text-center border border-zinc-200 rounded-xl bg-[#FAFBF9]">
          <p className="text-sm font-medium text-zinc-700">Você ainda não realizou nenhum pedido.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {orders.map((order) => {
            const pixPay = order.pagamentos?.find((p) => p.forma_pagamento === 'PIX');
            const currentStepIdx = DELIVERY_STEPS.indexOf(order.situacao_entrega);

            return (
              <article key={order.id} className="border border-zinc-200 rounded-xl bg-white overflow-hidden">
                {/* Order header */}
                <div className="px-6 py-4 bg-[#FAFBF9] border-b border-zinc-200 flex flex-wrap items-center justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="font-bold text-zinc-900 font-mono-tabular">
                      Pedido #{order.numero_pedido}
                    </span>
                    <span aria-hidden="true" className="text-zinc-300">·</span>
                    <span className="text-zinc-600">{formatDateTimeBR(order.criado_em)}</span>
                    <span aria-hidden="true" className="text-zinc-300">·</span>
                    <span className="text-zinc-700 font-medium">
                      {PAYMENT_METHOD_LABEL[order.forma_pagamento]}
                    </span>
                  </div>

                  <div className="flex items-center gap-4 text-xs font-semibold">
                    <span
                      className={
                        order.situacao_financeira === 'PAGO'
                          ? 'text-[#143824]'
                          : order.situacao_financeira === 'RECUSADO' || order.situacao_financeira === 'CANCELADO'
                          ? 'text-red-700'
                          : 'text-amber-800'
                      }
                    >
                      {FINANCE_STATUS_LABEL[order.situacao_financeira]}
                    </span>
                    <span aria-hidden="true" className="text-zinc-300">/</span>
                    <span className="text-zinc-900">{DELIVERY_STATUS_LABEL[order.situacao_entrega]}</span>
                  </div>
                </div>

                {/* Delivery progress bar */}
                {order.situacao_entrega !== 'CANCELADO' && (
                  <div className="px-6 py-4 border-b border-zinc-100">
                    <div className="grid grid-cols-4 gap-2">
                      {DELIVERY_STEPS.map((step, idx) => {
                        const reached = idx <= currentStepIdx;
                        return (
                          <div key={step} className="space-y-1.5">
                            <div
                              className={`h-1.5 rounded-full ${
                                reached ? 'bg-[#143824]' : 'bg-zinc-200'
                              }`}
                            />
                            <p
                              className={`text-[11px] font-medium ${
                                reached ? 'text-[#143824]' : 'text-zinc-400'
                              }`}
                            >
                              {DELIVERY_STATUS_LABEL[step]}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Items & Address */}
                <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="md:col-span-2 space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                      Itens do pedido
                    </h4>
                    <div className="divide-y divide-zinc-100">
                      {order.itens.map((it) => (
                        <div key={it.id} className="py-2.5 flex items-center justify-between gap-4 text-sm">
                          <div>
                            <div className="font-medium text-zinc-900">{it.nome_produto_snapshot}</div>
                            <div className="text-xs text-zinc-500">
                              {it.modo_compra === 'UNIDADE'
                                ? `${it.quantidade} un.`
                                : `${formatWeight(it.quantidade, 3)} kg`}
                              {it.valor_desejado_centavos
                                ? ` · pedido de ${formatBRL(it.valor_desejado_centavos)}`
                                : ''}
                            </div>
                          </div>
                          <span className="font-semibold text-zinc-900 font-mono-tabular">
                            {formatBRL(it.subtotal_centavos)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-4 md:border-l md:border-zinc-200 md:pl-6">
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">
                        Entrega
                      </h4>
                      <p className="text-xs text-zinc-700 leading-relaxed">
                        {order.endereco_rua}, {order.endereco_numero}
                        {order.endereco_complemento ? ` — ${order.endereco_complemento}` : ''}
                        <br />
                        {order.endereco_bairro} · {order.endereco_cidade}/{order.endereco_estado}
                        <br />
                        CEP {order.endereco_cep}
                      </p>
                    </div>

                    <div className="pt-3 border-t border-zinc-100 space-y-1 text-xs">
                      <div className="flex justify-between text-zinc-600">
                        <span>Subtotal</span>
                        <span className="font-mono-tabular">{formatBRL(order.subtotal_centavos)}</span>
                      </div>
                      <div className="flex justify-between text-zinc-600">
                        <span>Frete</span>
                        <span className="font-mono-tabular">{formatBRL(order.frete_centavos)}</span>
                      </div>
                      <div className="flex justify-between text-sm font-bold text-zinc-900 pt-1">
                        <span>Total</span>
                        <span className="font-mono-tabular text-[#143824]">{formatBRL(order.total_centavos)}</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => onOpenOrderChat(order.id)}
                      className="w-full py-2 px-3 border border-zinc-300 hover:border-[#143824] text-xs font-semibold text-zinc-800 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <MessageSquare className="w-3.5 h-3.5 text-[#143824]" />
                      <span>Falar sobre este pedido</span>
                    </button>
                  </div>
                </div>

                {/* Pending PIX block */}
                {order.situacao_financeira === 'AGUARDANDO_PAGAMENTO' && pixPay?.pix_qr_code && (
                  <div className="px-6 py-4 bg-[#F5F2EB] border-t border-zinc-200 flex flex-wrap items-center justify-between gap-4">
                    <div className="text-xs text-zinc-700">
                      <strong>PIX aguardando pagamento:</strong> copie o código ou atualize a verificação após pagar.
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(pixPay.pix_qr_code || '');
                          setCopiedId(order.id);
                          setTimeout(() => setCopiedId(null), 2000);
                        }}
                        className="px-3 py-1.5 bg-[#143824] text-white text-xs font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        {copiedId === order.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedId === order.id ? 'Copiado' : 'Copiar código PIX'}</span>
                      </button>
                      <button
                        type="button"
                        disabled={checkingId === order.id}
                        onClick={() => verifyPayment(order.id)}
                        className="px-3 py-1.5 border border-[#143824] text-[#143824] text-xs font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${checkingId === order.id ? 'animate-spin' : ''}`} />
                        <span>Verificar</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* History timeline */}
                {order.historico && order.historico.length > 0 && (
                  <div className="px-6 py-3 bg-zinc-50 border-t border-zinc-200">
                    <details className="text-xs text-zinc-600">
                      <summary className="cursor-pointer font-medium text-zinc-700">
                        Histórico de atualizações ({order.historico.length})
                      </summary>
                      <ul className="mt-2 space-y-1.5 pl-2">
                        {order.historico.map((h) => (
                          <li key={h.id} className="flex flex-wrap gap-2">
                            <span className="font-mono-tabular text-zinc-400">
                              {formatDateTimeBR(h.criado_em)}
                            </span>
                            <span>—</span>
                            <span className="text-zinc-800">{h.descricao}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
