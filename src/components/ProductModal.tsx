import { useState, useMemo } from 'react';
import { X, Minus, Plus, Scale, Banknote, Package, CheckCircle2, AlertCircle } from 'lucide-react';
import { formatBRL, formatWeight } from '../lib/format.ts';
import type { ModoCompra, Product, PublicConfig } from '../types.ts';

interface ProductModalProps {
  product: Product;
  config: PublicConfig;
  onClose: () => void;
  onAddToCart: (payload: {
    produtoId: string;
    modoCompra: ModoCompra;
    quantidade?: number;
    valorDesejadoCentavos?: number;
  }) => Promise<void>;
}

export function ProductModal({ product, config, onClose, onAddToCart }: ProductModalProps) {
  const images = product.imagens?.length
    ? product.imagens
    : product.imagem_principal
    ? [{ id: 'main', produto_id: product.id, url: product.imagem_principal, nome_arquivo: null, principal: 1, ordem: 0 }]
    : [];

  const [activeImage, setActiveImage] = useState(images[0]?.url || '');
  const [imgFailed, setImgFailed] = useState(false);

  const defaultMode: ModoCompra =
    product.modalidade_venda === 'UNIDADE'
      ? 'UNIDADE'
      : product.modalidade_venda === 'VALOR_DINHEIRO'
      ? 'VALOR_DINHEIRO'
      : 'PESO_KG';

  const [modoCompra, setModoCompra] = useState<ModoCompra>(defaultMode);
  const [unidades, setUnidades] = useState(1);
  const [pesoKgInput, setPesoKgInput] = useState('1');
  const [valorReaisInput, setValorReaisInput] = useState('50,00');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedSuccess, setAddedSuccess] = useState(false);

  const isOut = product.situacao === 'ESGOTADO' || product.estoque_quantidade <= 0;
  const precisao = product.precisao_pesagem ?? config.precisao_pesagem_padrao ?? 3;
  const precoUnit = product.preco_vigente_centavos;

  const parsedKg = useMemo(() => {
    const val = Number(pesoKgInput.replace(',', '.'));
    return Number.isFinite(val) && val > 0 ? val : 0;
  }, [pesoKgInput]);

  const parsedValorCentavos = useMemo(() => {
    const cleaned = valorReaisInput.replace(/[^\d,.]/g, '').replace(',', '.');
    const val = Number(cleaned);
    return Number.isFinite(val) && val > 0 ? Math.round(val * 100) : 0;
  }, [valorReaisInput]);

  const pesoCalculadoPorValor = useMemo(() => {
    if (precoUnit <= 0 || parsedValorCentavos <= 0) return 0;
    const fator = Math.pow(10, precisao);
    return Math.round((parsedValorCentavos / precoUnit) * fator) / fator;
  }, [parsedValorCentavos, precoUnit, precisao]);

  const subtotalCentavos = useMemo(() => {
    if (modoCompra === 'UNIDADE') return unidades * precoUnit;
    if (modoCompra === 'PESO_KG') return Math.round(parsedKg * precoUnit);
    return parsedValorCentavos;
  }, [modoCompra, unidades, parsedKg, parsedValorCentavos, precoUnit]);

  const exceedsStock = useMemo(() => {
    if (modoCompra === 'UNIDADE') return unidades > product.estoque_quantidade;
    if (modoCompra === 'PESO_KG') return parsedKg > product.estoque_quantidade;
    return pesoCalculadoPorValor > product.estoque_quantidade;
  }, [modoCompra, unidades, parsedKg, pesoCalculadoPorValor, product.estoque_quantidade]);

  async function handleConfirm() {
    setError(null);
    setAddedSuccess(false);
    setSubmitting(true);
    try {
      await onAddToCart({
        produtoId: product.id,
        modoCompra,
        quantidade: modoCompra === 'UNIDADE' ? unidades : modoCompra === 'PESO_KG' ? parsedKg : undefined,
        valorDesejadoCentavos: modoCompra === 'VALOR_DINHEIRO' ? parsedValorCentavos : undefined,
      });
      setAddedSuccess(true);
      setTimeout(() => {
        onClose();
      }, 650);
    } catch (err: any) {
      setError(err?.message || 'Erro ao adicionar ao carrinho.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl max-w-4xl w-full border border-zinc-200 shadow-2xl overflow-hidden my-auto">
        <div className="px-6 py-4 border-b border-zinc-200 flex items-center justify-between bg-[#FAFBF9]">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="uppercase tracking-wider font-medium">{product.categoria_nome}</span>
            <span aria-hidden="true">·</span>
            <span className={isOut ? 'text-red-700 font-semibold' : 'text-[#143824] font-semibold'}>
              {isOut
                ? 'Produto esgotado'
                : `Disponível: ${
                    product.modalidade_venda === 'UNIDADE'
                      ? `${product.estoque_quantidade} un.`
                      : `${formatWeight(product.estoque_quantidade, precisao)} kg`
                  }`}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-zinc-500 hover:text-zinc-900 rounded-md hover:bg-zinc-100 cursor-pointer"
            aria-label="Fechar detalhes"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2">
          {/* Left: Gallery */}
          <div className="p-6 bg-[#F5F2EB]/60 border-b md:border-b-0 md:border-r border-zinc-200 flex flex-col gap-4">
            <div className="aspect-[4/3] rounded-lg overflow-hidden bg-white border border-zinc-200 flex items-center justify-center">
              {activeImage && !imgFailed ? (
                <img
                  src={activeImage}
                  alt={product.nome}
                  referrerPolicy="no-referrer"
                  onError={() => setImgFailed(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <Package className="w-12 h-12 text-zinc-300" />
              )}
            </div>
            {images.length > 1 && (
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {images.map((img) => (
                  <button
                    key={img.id}
                    type="button"
                    onClick={() => {
                      setActiveImage(img.url);
                      setImgFailed(false);
                    }}
                    className={`w-16 h-12 rounded-md overflow-hidden border-2 shrink-0 cursor-pointer ${
                      activeImage === img.url ? 'border-[#143824]' : 'border-transparent opacity-70 hover:opacity-100'
                    }`}
                  >
                    <img src={img.url} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  </button>
                ))}
              </div>
            )}
            <div className="pt-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">
                Descrição do produto
              </h4>
              <p className="text-sm text-zinc-700 leading-relaxed">{product.descricao_completa}</p>
            </div>
          </div>

          {/* Right: Contiguous Purchase Module */}
          <div className="p-6 flex flex-col justify-between gap-5">
            <div className="space-y-4">
              <div>
                <h2 className="text-2xl font-bold text-zinc-900 leading-tight">{product.nome}</h2>
                <p className="text-sm text-zinc-600 mt-1">{product.observacao_curta}</p>
              </div>

              <div className="pb-4 border-b border-zinc-200">
                {product.oferta === 1 && product.preco_promocional_centavos ? (
                  <div className="text-sm text-zinc-400 line-through font-mono-tabular">
                    {formatBRL(product.preco_centavos)}
                  </div>
                ) : null}
                <div className="text-2xl font-bold text-[#143824] font-mono-tabular">
                  {formatBRL(precoUnit)}
                  <span className="text-sm font-normal text-zinc-500 ml-1.5">
                    {product.modalidade_venda === 'UNIDADE' ? '/ unidade' : '/ kg'}
                  </span>
                </div>
              </div>

              {/* Modality Switch for Peso e Valor */}
              {product.modalidade_venda === 'PESO_E_VALOR' && (
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-2">
                    Como deseja comprar?
                  </label>
                  <div className="grid grid-cols-2 gap-2 p-1 bg-zinc-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setModoCompra('PESO_KG')}
                      className={`flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                        modoCompra === 'PESO_KG'
                          ? 'bg-white text-[#143824] shadow-sm'
                          : 'text-zinc-600 hover:text-zinc-900'
                      }`}
                    >
                      <Scale className="w-3.5 h-3.5" />
                      <span>Por quilo (kg)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setModoCompra('VALOR_DINHEIRO')}
                      className={`flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                        modoCompra === 'VALOR_DINHEIRO'
                          ? 'bg-white text-[#143824] shadow-sm'
                          : 'text-zinc-600 hover:text-zinc-900'
                      }`}
                    >
                      <Banknote className="w-3.5 h-3.5" />
                      <span>Por valor (R$)</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Quantity / Weight / Money Selector */}
              {modoCompra === 'UNIDADE' && (
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-2">Quantidade (unidades)</label>
                  <div className="inline-flex items-center border border-zinc-300 rounded-lg overflow-hidden">
                    <button
                      type="button"
                      disabled={isOut || unidades <= 1}
                      onClick={() => setUnidades((u) => Math.max(1, u - 1))}
                      className="p-2.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 cursor-pointer"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <span className="px-5 py-2 text-sm font-semibold font-mono-tabular">{unidades}</span>
                    <button
                      type="button"
                      disabled={isOut || unidades >= product.estoque_quantidade}
                      onClick={() => setUnidades((u) => u + 1)}
                      className="p-2.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {modoCompra === 'PESO_KG' && (
                <div className="space-y-3">
                  <label className="block text-xs font-medium text-zinc-700">Selecione ou informe o peso (kg)</label>
                  <div className="flex flex-wrap gap-2">
                    {[1, 2, 3, 5].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        disabled={isOut || preset > product.estoque_quantidade}
                        onClick={() => setPesoKgInput(String(preset))}
                        className={`px-3.5 py-2 text-xs font-semibold rounded-lg border transition-colors cursor-pointer disabled:opacity-40 ${
                          Number(pesoKgInput.replace(',', '.')) === preset
                            ? 'bg-[#143824] text-white border-[#143824]'
                            : 'bg-white text-zinc-700 border-zinc-300 hover:border-[#143824]'
                        }`}
                      >
                        {preset} kg
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step={precisao === 3 ? '0.001' : '0.1'}
                      min="0.05"
                      max={product.estoque_quantidade}
                      disabled={isOut}
                      value={pesoKgInput}
                      onChange={(e) => setPesoKgInput(e.target.value)}
                      className="w-36 px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular focus:outline-none focus:ring-2 focus:ring-[#143824]"
                    />
                    <span className="text-sm text-zinc-500">kg personalizado</span>
                  </div>
                </div>
              )}

              {modoCompra === 'VALOR_DINHEIRO' && (
                <div className="space-y-3">
                  <label className="block text-xs font-medium text-zinc-700">
                    Quanto deseja gastar? (R$)
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {['20,00', '35,00', '50,00', '100,00'].map((val) => (
                      <button
                        key={val}
                        type="button"
                        disabled={isOut}
                        onClick={() => setValorReaisInput(val)}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors cursor-pointer ${
                          valorReaisInput === val
                            ? 'bg-[#143824] text-white border-[#143824]'
                            : 'bg-white text-zinc-700 border-zinc-300 hover:border-[#143824]'
                        }`}
                      >
                        R$ {val}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-600">R$</span>
                    <input
                      type="text"
                      disabled={isOut}
                      value={valorReaisInput}
                      onChange={(e) => setValorReaisInput(e.target.value)}
                      placeholder="50,00"
                      className="w-36 px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular focus:outline-none focus:ring-2 focus:ring-[#143824]"
                    />
                  </div>
                  <div className="p-3 rounded-lg bg-[#F5F2EB] text-xs text-zinc-700 flex items-center justify-between">
                    <span>Quantidade equivalente calculada:</span>
                    <strong className="font-mono-tabular text-sm text-[#143824]">
                      {formatWeight(pesoCalculadoPorValor, precisao)} kg
                    </strong>
                  </div>
                </div>
              )}

              {exceedsStock && !isOut && (
                <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>Quantidade acima do estoque disponível.</span>
                </div>
              )}

              {error && (
                <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {addedSuccess && (
                <div className="p-2.5 rounded-lg bg-[#e9f2ec] border border-[#143824]/20 text-xs text-[#143824] flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>Adicionado ao carrinho com sucesso.</span>
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-zinc-200 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-600">Total do item</span>
                <span className="text-lg font-bold text-zinc-900 font-mono-tabular">
                  {formatBRL(subtotalCentavos)}
                </span>
              </div>
              <button
                type="button"
                disabled={isOut || submitting || exceedsStock || subtotalCentavos <= 0}
                onClick={handleConfirm}
                className="w-full py-3 px-5 bg-[#143824] hover:bg-[#1f5135] disabled:bg-zinc-300 disabled:text-zinc-500 text-white text-sm font-semibold rounded-lg transition-colors cursor-pointer"
              >
                {isOut
                  ? 'Produto esgotado'
                  : submitting
                  ? 'Adicionando...'
                  : 'Adicionar ao carrinho'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
