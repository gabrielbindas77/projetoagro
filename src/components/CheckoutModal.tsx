import { useEffect, useState, type FormEvent } from 'react';
import { X, MapPin, CreditCard, QrCode, Banknote, Copy, Check, AlertCircle, RefreshCw } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import { formatBRL, maskCEP, FINANCE_STATUS_LABEL } from '../lib/format.ts';
import type { Address, CartState, Order, PaymentRecord, PublicConfig, User } from '../types.ts';

interface CheckoutModalProps {
  cart: CartState;
  config: PublicConfig;
  user: User;
  onClose: () => void;
  onOrderCreated: (order: Order) => void;
}

declare global {
  interface Window {
    MercadoPago?: any;
  }
}

export function CheckoutModal({ cart, config, user, onClose, onOrderCreated }: CheckoutModalProps) {
  const [address, setAddress] = useState<Address>({
    cep: '',
    rua: '',
    numero: '',
    complemento: '',
    bairro: '',
    cidade: '',
    estado: '',
  });
  const [cepLoading, setCepLoading] = useState(false);
  const [cepError, setCepError] = useState<string | null>(null);

  const [formaPagamento, setFormaPagamento] = useState<'PIX' | 'CARTAO_CREDITO' | 'DINHEIRO_NA_ENTREGA'>('PIX');
  const [observacoes, setObservacoes] = useState('');

  // Mercado Pago card fields (tokenized purely via MP JS SDK on client, never stored or sent raw)
  const [cardNumber, setCardNumber] = useState('');
  const [cardName, setCardName] = useState(user.nome_completo.toUpperCase());
  const [cardExpMonth, setCardExpMonth] = useState('');
  const [cardExpYear, setCardExpYear] = useState('');
  const [cardCvv, setCardCvv] = useState('');
  const [mpPaymentMethodId, setMpPaymentMethodId] = useState('');
  const [mpIssuerId, setMpIssuerId] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Result state after creating order
  const [createdOrder, setCreatedOrder] = useState<Order | null>(null);
  const [createdPayment, setCreatedPayment] = useState<PaymentRecord | null>(null);
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null);
  const [copiedPix, setCopiedPix] = useState(false);
  const [checkingPayment, setCheckingPayment] = useState(false);

  // Load saved address if available
  useEffect(() => {
    apiFetch<Address[]>('/api/enderecos')
      .then((rows) => {
        if (rows.length > 0) {
          setAddress({
            cep: maskCEP(rows[0].cep),
            rua: rows[0].rua,
            numero: rows[0].numero,
            complemento: rows[0].complemento || '',
            bairro: rows[0].bairro,
            cidade: rows[0].cidade,
            estado: rows[0].estado,
          });
        }
      })
      .catch(() => {});
  }, []);

  // Load Mercado Pago JS SDK v2 when public key exists
  useEffect(() => {
    if (!config.mercado_pago_public_key || window.MercadoPago) return;
    const script = document.createElement('script');
    script.src = 'https://sdk.mercadopago.com/js/v2';
    script.async = true;
    document.body.appendChild(script);
  }, [config.mercado_pago_public_key]);

  // Detect card brand/issuer via Mercado Pago when card BIN (6+ digits) is entered
  useEffect(() => {
    const bin = cardNumber.replace(/\D/g, '');
    if (formaPagamento !== 'CARTAO_CREDITO' || bin.length < 6 || !config.mercado_pago_configurado) {
      return;
    }
    const amount = (cart.total_centavos / 100).toFixed(2);
    apiFetch<any>(`/api/pagamentos/mp/parcelas?amount=${amount}&bin=${bin.slice(0, 6)}`)
      .then((res) => {
        if (res.payment_method_id) setMpPaymentMethodId(res.payment_method_id);
        if (res.issuer_id) setMpIssuerId(String(res.issuer_id));
      })
      .catch(() => {});
  }, [cardNumber, formaPagamento, cart.total_centavos, config.mercado_pago_configurado]);

  async function lookupCEP(rawCep: string) {
    const clean = rawCep.replace(/\D/g, '');
    setAddress((prev) => ({ ...prev, cep: maskCEP(rawCep) }));
    setCepError(null);
    if (clean.length !== 8) return;

    setCepLoading(true);
    try {
      const data = await apiFetch<Address>(`/api/cep/${clean}`);
      setAddress((prev) => ({
        ...prev,
        cep: maskCEP(clean),
        rua: data.rua || prev.rua,
        bairro: data.bairro || prev.bairro,
        cidade: data.cidade || prev.cidade,
        estado: data.estado || prev.estado,
        complemento: data.complemento || prev.complemento,
      }));
    } catch (err: any) {
      setCepError(err?.message || 'CEP não encontrado.');
    } finally {
      setCepLoading(false);
    }
  }

  async function handleFinalizeOrder(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      let cardPayment: any = undefined;

      if (formaPagamento === 'CARTAO_CREDITO') {
        if (!config.mercado_pago_public_key || !config.mercado_pago_configurado) {
          throw new Error(
            'Pagamentos com cartão requerem MERCADOPAGO_PUBLIC_KEY e MERCADOPAGO_ACCESS_TOKEN configurados no servidor.'
          );
        }
        if (!window.MercadoPago) {
          throw new Error('SDK do Mercado Pago ainda não carregado. Aguarde um instante e tente novamente.');
        }

        const mp = new window.MercadoPago(config.mercado_pago_public_key, { locale: 'pt-BR' });
        const tokenResp = await mp.createCardToken({
          cardNumber: cardNumber.replace(/\D/g, ''),
          cardholderName: cardName,
          cardExpirationMonth: cardExpMonth,
          cardExpirationYear: cardExpYear.length === 2 ? `20${cardExpYear}` : cardExpYear,
          securityCode: cardCvv,
          identificationType: 'CPF',
          identificationNumber: user.cpf,
        });

        if (!tokenResp?.id) {
          throw new Error('Não foi possível tokenizar os dados do cartão no Mercado Pago.');
        }

        cardPayment = {
          token: tokenResp.id,
          payment_method_id: mpPaymentMethodId || tokenResp.payment_method_id || 'visa',
          issuer_id: mpIssuerId || undefined,
        };
      }

      const res = await apiFetch<{
        pedido: Order;
        pagamento: PaymentRecord;
        paymentNotice: string | null;
      }>('/api/pedidos', {
        method: 'POST',
        body: JSON.stringify({
          endereco: { ...address, cep: address.cep.replace(/\D/g, '') },
          formaPagamento,
          parcelas: 1,
          observacoes,
          cardPayment,
        }),
      });

      setCreatedOrder(res.pedido);
      setCreatedPayment(res.pagamento);
      setPaymentNotice(res.paymentNotice);
      onOrderCreated(res.pedido);
    } catch (err: any) {
      setError(err?.message || 'Erro ao finalizar pedido.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCheckRealPayment() {
    if (!createdOrder) return;
    setCheckingPayment(true);
    try {
      const res = await apiFetch<{ pedido: Order }>(`/api/pedidos/${createdOrder.id}/verificar-pagamento`, {
        method: 'POST',
      });
      setCreatedOrder(res.pedido);
      if (res.pedido.pagamentos?.[0]) setCreatedPayment(res.pedido.pagamentos[0]);
      onOrderCreated(res.pedido);
    } catch (err: any) {
      setError(err?.message || 'Erro ao consultar pagamento.');
    } finally {
      setCheckingPayment(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl max-w-3xl w-full border border-zinc-200 shadow-2xl overflow-hidden my-auto">
        <div className="px-6 py-4 border-b border-zinc-200 flex items-center justify-between bg-[#FAFBF9]">
          <h2 className="text-base font-semibold text-zinc-900">
            {createdOrder ? `Pedido #${createdOrder.numero_pedido} registrado` : 'Finalizar compra'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-zinc-500 hover:text-zinc-900 rounded-md hover:bg-zinc-100 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {createdOrder ? (
          <div className="p-6 space-y-5">
            <div className="p-4 rounded-lg bg-[#F5F2EB] border border-zinc-200 flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs text-zinc-600">Situação financeira</p>
                <p className="text-base font-bold text-zinc-900">
                  {FINANCE_STATUS_LABEL[createdOrder.situacao_financeira] || createdOrder.situacao_financeira}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-zinc-600">Valor total</p>
                <p className="text-lg font-bold text-[#143824] font-mono-tabular">
                  {formatBRL(createdOrder.total_centavos)}
                </p>
              </div>
            </div>

            {paymentNotice && (
              <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{paymentNotice}</span>
              </div>
            )}

            {createdOrder.forma_pagamento === 'PIX' && createdPayment?.pix_qr_code && (
              <div className="p-5 rounded-xl border border-zinc-200 bg-white text-center space-y-4">
                <h3 className="text-sm font-semibold text-zinc-900">Pague com PIX via Mercado Pago</h3>
                {createdPayment.pix_qr_code_base64 && (
                  <img
                    src={`data:image/png;base64,${createdPayment.pix_qr_code_base64}`}
                    alt="QR Code PIX"
                    className="w-48 h-48 mx-auto border border-zinc-200 rounded-lg p-2"
                  />
                )}
                <div className="text-left">
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Código PIX Copia e Cola</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      readOnly
                      value={createdPayment.pix_qr_code}
                      className="flex-1 px-3 py-2 text-xs bg-zinc-50 border border-zinc-300 rounded-lg font-mono-tabular"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(createdPayment.pix_qr_code || '');
                        setCopiedPix(true);
                        setTimeout(() => setCopiedPix(false), 2000);
                      }}
                      className="px-3.5 py-2 bg-[#143824] text-white text-xs font-medium rounded-lg flex items-center gap-1.5 cursor-pointer"
                    >
                      {copiedPix ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedPix ? 'Copiado' : 'Copiar'}</span>
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={checkingPayment}
                  onClick={handleCheckRealPayment}
                  className="inline-flex items-center gap-2 px-4 py-2 border border-[#143824] text-[#143824] text-xs font-semibold rounded-lg hover:bg-[#e9f2ec] cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${checkingPayment ? 'animate-spin' : ''}`} />
                  <span>Atualizar status no Mercado Pago</span>
                </button>
              </div>
            )}

            {createdOrder.forma_pagamento === 'DINHEIRO_NA_ENTREGA' && (
              <p className="text-sm text-zinc-700 bg-[#e9f2ec] p-4 rounded-lg">
                Pagamento selecionado: <strong>Dinheiro na entrega</strong>. O pedido permanecerá como{' '}
                <em>Aguardando pagamento</em> até a confirmação do recebimento pelo entregador/administrador.
              </p>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2.5 bg-[#143824] text-white text-sm font-semibold rounded-lg cursor-pointer"
              >
                Acompanhar em Meus Pedidos
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleFinalizeOrder} className="p-6 space-y-6 max-h-[82vh] overflow-y-auto">
            {error && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Step 1: Delivery Address with ViaCEP */}
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                <MapPin className="w-4 h-4 text-[#143824]" />
                <h3>Endereço de entrega</h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">CEP (ViaCEP automático)</label>
                  <input
                    type="text"
                    required
                    placeholder="00000-000"
                    value={address.cep}
                    onChange={(e) => lookupCEP(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                  />
                  {cepLoading && <span className="text-[11px] text-zinc-500">Consultando CEP...</span>}
                  {cepError && <span className="text-[11px] text-red-700">{cepError}</span>}
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Rua / Logradouro</label>
                  <input
                    type="text"
                    required
                    value={address.rua}
                    onChange={(e) => setAddress({ ...address, rua: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Número</label>
                  <input
                    type="text"
                    required
                    value={address.numero}
                    onChange={(e) => setAddress({ ...address, numero: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Complemento</label>
                  <input
                    type="text"
                    value={address.complemento}
                    onChange={(e) => setAddress({ ...address, complemento: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Bairro</label>
                  <input
                    type="text"
                    required
                    value={address.bairro}
                    onChange={(e) => setAddress({ ...address, bairro: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Cidade</label>
                  <input
                    type="text"
                    required
                    value={address.cidade}
                    onChange={(e) => setAddress({ ...address, cidade: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Estado (UF)</label>
                  <input
                    type="text"
                    required
                    maxLength={2}
                    value={address.estado}
                    onChange={(e) => setAddress({ ...address, estado: e.target.value.toUpperCase() })}
                    className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg uppercase"
                  />
                </div>
              </div>
            </section>

            {/* Step 2: Payment Method */}
            <section className="space-y-3 pt-4 border-t border-zinc-200">
              <h3 className="text-sm font-semibold text-zinc-900">Forma de pagamento</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <button
                  type="button"
                  onClick={() => setFormaPagamento('PIX')}
                  className={`p-3.5 rounded-lg border text-left transition-colors cursor-pointer ${
                    formaPagamento === 'PIX'
                      ? 'border-[#143824] bg-[#e9f2ec]/60'
                      : 'border-zinc-200 hover:border-zinc-400'
                  }`}
                >
                  <QrCode className="w-4 h-4 text-[#143824] mb-1.5" />
                  <div className="text-sm font-semibold text-zinc-900">PIX</div>
                  <div className="text-xs text-zinc-500">QR Code Mercado Pago</div>
                </button>
                <button
                  type="button"
                  onClick={() => setFormaPagamento('CARTAO_CREDITO')}
                  className={`p-3.5 rounded-lg border text-left transition-colors cursor-pointer ${
                    formaPagamento === 'CARTAO_CREDITO'
                      ? 'border-[#143824] bg-[#e9f2ec]/60'
                      : 'border-zinc-200 hover:border-zinc-400'
                  }`}
                >
                  <CreditCard className="w-4 h-4 text-[#143824] mb-1.5" />
                  <div className="text-sm font-semibold text-zinc-900">Cartão de crédito</div>
                  <div className="text-xs text-zinc-500">À vista via Mercado Pago</div>
                </button>
                <button
                  type="button"
                  onClick={() => setFormaPagamento('DINHEIRO_NA_ENTREGA')}
                  className={`p-3.5 rounded-lg border text-left transition-colors cursor-pointer ${
                    formaPagamento === 'DINHEIRO_NA_ENTREGA'
                      ? 'border-[#143824] bg-[#e9f2ec]/60'
                      : 'border-zinc-200 hover:border-zinc-400'
                  }`}
                >
                  <Banknote className="w-4 h-4 text-[#143824] mb-1.5" />
                  <div className="text-sm font-semibold text-zinc-900">Dinheiro na entrega</div>
                  <div className="text-xs text-zinc-500">Pague ao receber</div>
                </button>
              </div>

              {formaPagamento === 'CARTAO_CREDITO' && (
                <div className="p-4 rounded-lg border border-zinc-200 bg-zinc-50 space-y-3">
                  {!config.mercado_pago_configurado || !config.mercado_pago_public_key ? (
                    <p className="text-xs text-amber-800">
                      Para processar cartão com tokenização oficial, configure{' '}
                      <code>MERCADOPAGO_PUBLIC_KEY</code> e <code>MERCADOPAGO_ACCESS_TOKEN</code> nas
                      variáveis de ambiente do servidor.
                    </p>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-zinc-700 mb-1">Número do cartão</label>
                          <input
                            type="text"
                            required
                            placeholder="0000 0000 0000 0000"
                            value={cardNumber}
                            onChange={(e) => setCardNumber(e.target.value)}
                            className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-lg font-mono-tabular"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-700 mb-1">Nome impresso no cartão</label>
                          <input
                            type="text"
                            required
                            value={cardName}
                            onChange={(e) => setCardName(e.target.value)}
                            className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-lg"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-zinc-700 mb-1">Mês (MM)</label>
                          <input
                            type="text"
                            required
                            maxLength={2}
                            placeholder="12"
                            value={cardExpMonth}
                            onChange={(e) => setCardExpMonth(e.target.value)}
                            className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-lg font-mono-tabular"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-700 mb-1">Ano (AAAA)</label>
                          <input
                            type="text"
                            required
                            maxLength={4}
                            placeholder="2029"
                            value={cardExpYear}
                            onChange={(e) => setCardExpYear(e.target.value)}
                            className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-lg font-mono-tabular"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-700 mb-1">CVV</label>
                          <input
                            type="password"
                            required
                            maxLength={4}
                            placeholder="123"
                            value={cardCvv}
                            onChange={(e) => setCardCvv(e.target.value)}
                            className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-lg font-mono-tabular"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-zinc-600">
                        Pagamento à vista no cartão de crédito: <strong className="font-mono-tabular">{formatBRL(cart.total_centavos)}</strong>
                      </p>
                    </>
                  )}
                </div>
              )}
            </section>

            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">Observações da entrega (opcional)</label>
              <input
                type="text"
                value={observacoes}
                onChange={(e) => setObservacoes(e.target.value)}
                placeholder="Ex.: portão verde, entregar na recepção da fazenda..."
                className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
              />
            </div>

            {/* Order Totals Summary */}
            <div className="p-4 rounded-lg bg-[#F5F2EB] space-y-1.5 text-sm">
              <div className="flex justify-between text-zinc-600">
                <span>Produtos ({cart.itens.length})</span>
                <span className="font-mono-tabular">{formatBRL(cart.subtotal_centavos)}</span>
              </div>
              <div className="flex justify-between text-zinc-600">
                <span>Frete</span>
                <span className="font-mono-tabular">{formatBRL(cart.frete_centavos)}</span>
              </div>
              <div className="pt-2 border-t border-zinc-300 flex justify-between font-bold text-zinc-900 text-base">
                <span>Total a pagar</span>
                <span className="font-mono-tabular text-[#143824]">{formatBRL(cart.total_centavos)}</span>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 px-5 bg-[#143824] hover:bg-[#1f5135] disabled:opacity-60 text-white text-sm font-semibold rounded-lg cursor-pointer"
            >
              {submitting ? 'Processando pedido...' : 'Confirmar pedido'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
