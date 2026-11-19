import { useEffect, useState } from 'react';
import { X, Trash2, ShoppingBag, ArrowRight } from 'lucide-react';
import { formatBRL, formatWeight } from '../lib/format.ts';
import type { CartItem, CartState } from '../types.ts';

interface CartDrawerProps {
  open: boolean;
  cart: CartState;
  onClose: () => void;
  onUpdateItem: (item: CartItem, nextValue: { quantidade: number }) => Promise<void>;
  onRemoveItem: (itemId: string) => Promise<void>;
  onCheckout: () => void;
}

function KgQuantityInput({
  item,
  onCommit,
}: {
  item: CartItem;
  onCommit: (nextQty: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(item.quantidade));

  useEffect(() => {
    setDraft(String(item.quantidade));
  }, [item.quantidade]);

  async function commitValue() {
    const normalized = Number(draft.replace(',', '.'));
    if (Number.isFinite(normalized) && normalized > 0 && normalized !== item.quantidade) {
      await onCommit(Number(normalized.toFixed(3)));
    } else {
      setDraft(String(item.quantidade));
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        step="0.05"
        min="0.05"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitValue}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitValue();
          }
        }}
        className="w-20 px-2 py-1 text-xs border border-zinc-300 rounded font-mono-tabular focus:outline-none focus:ring-1 focus:ring-[#143824]"
      />
      <span className="text-xs text-zinc-500">kg</span>
    </div>
  );
}

export function CartDrawer({
  open,
  cart,
  onClose,
  onUpdateItem,
  onRemoveItem,
  onCheckout,
}: CartDrawerProps) {
  if (!open) return null;

  const shippingCentavos = cart.itens.length > 0 ? 499 : 0;
  const totalCentavos = cart.subtotal_centavos + shippingCentavos;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/45">
      <div className="bg-white w-full max-w-md h-full flex flex-col shadow-2xl border-l border-zinc-200">
        <div className="px-6 py-4 border-b border-zinc-200 flex items-center justify-between bg-[#FAFBF9]">
          <div className="flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-[#143824]" />
            <h2 className="text-base font-semibold text-zinc-900">Carrinho de compras</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-zinc-500 hover:text-zinc-900 rounded-md hover:bg-zinc-100 cursor-pointer"
            aria-label="Fechar carrinho"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {cart.itens.length === 0 ? (
            <div className="text-center py-16 space-y-3">
              <ShoppingBag className="w-10 h-10 text-zinc-300 mx-auto" />
              <p className="text-sm font-medium text-zinc-700">Seu carrinho está vazio</p>
              <p className="text-xs text-zinc-500">
                Explore o catálogo e adicione rações, sementes, ferramentas ou insumos.
              </p>
            </div>
          ) : (
            cart.itens.map((item) => {
              const isKg = item.unit_type === 'kg' || item.modo_compra === 'PESO_KG';
              return (
                <div key={item.id} className="pb-4 border-b border-zinc-200 flex gap-3.5">
                  <div className="w-20 h-16 rounded-lg overflow-hidden bg-[#F5F2EB] shrink-0 border border-zinc-200">
                    {item.imagem_principal ? (
                      <img
                        src={item.imagem_principal}
                        alt={item.produto_nome}
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : null}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold text-zinc-900 truncate">{item.produto_nome}</h3>
                      <button
                        type="button"
                        onClick={() => onRemoveItem(item.id)}
                        className="text-zinc-400 hover:text-red-700 p-1 cursor-pointer"
                        aria-label="Remover item"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <p className="text-xs text-zinc-500 mt-0.5">
                      {!isKg
                        ? `${item.quantidade} un. × ${formatBRL(item.preco_unitario_snapshot_centavos)}`
                        : `${formatWeight(item.quantidade, item.precisao_pesagem)} kg × ${formatBRL(
                            item.preco_unitario_snapshot_centavos
                          )}/kg`}
                    </p>

                    <div className="mt-2.5 flex items-center justify-between gap-2">
                      {!isKg ? (
                        <div className="inline-flex items-center border border-zinc-300 rounded-md">
                          <button
                            type="button"
                            onClick={() =>
                              item.quantidade > 1
                                ? onUpdateItem(item, { quantidade: item.quantidade - 1 })
                                : onRemoveItem(item.id)
                            }
                            className="px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 cursor-pointer"
                          >
                            -
                          </button>
                          <span className="px-2.5 text-xs font-mono-tabular">{item.quantidade}</span>
                          <button
                            type="button"
                            onClick={() => onUpdateItem(item, { quantidade: item.quantidade + 1 })}
                            className="px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 cursor-pointer"
                          >
                            +
                          </button>
                        </div>
                      ) : (
                        <KgQuantityInput
                          item={item}
                          onCommit={(nextQty) => onUpdateItem(item, { quantidade: nextQty })}
                        />
                      )}

                      <span className="text-sm font-bold text-zinc-900 font-mono-tabular">
                        {formatBRL(item.subtotal_centavos)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {cart.itens.length > 0 && (
          <div className="p-6 border-t border-zinc-200 bg-[#FAFBF9] space-y-3">
            <div className="flex items-center justify-between text-sm text-zinc-600">
              <span>Subtotal</span>
              <span className="font-mono-tabular">{formatBRL(cart.subtotal_centavos)}</span>
            </div>
            <div className="flex items-center justify-between text-sm text-zinc-600">
              <span>Frete fixo obrigatório</span>
              <span className="font-mono-tabular">{formatBRL(shippingCentavos)}</span>
            </div>
            <div className="text-xs font-semibold text-[#143824] bg-[#e9f2ec] px-2.5 py-1 rounded">
              Frete fixo de R$ 4,99.
            </div>
            <div className="pt-2 border-t border-zinc-200 flex items-center justify-between text-base font-bold text-zinc-900">
              <span>Total</span>
              <span className="font-mono-tabular text-[#143824]">{formatBRL(totalCentavos)}</span>
            </div>
            <button
              type="button"
              onClick={onCheckout}
              className="w-full py-3 px-4 bg-[#143824] hover:bg-[#1f5135] text-white text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <span>Finalizar compra</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
