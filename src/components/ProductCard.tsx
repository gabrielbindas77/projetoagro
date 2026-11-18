import { useState } from 'react';
import { Package } from 'lucide-react';
import { formatBRL } from '../lib/format.ts';
import type { Product } from '../types.ts';

interface ProductCardProps {
  product: Product;
  onSelect: (product: Product) => void;
}

export function ProductCard({ product, onSelect }: ProductCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const isOut = product.situacao === 'ESGOTADO' || product.estoque_quantidade <= 0;
  const hasPromo =
    product.oferta === 1 &&
    product.preco_promocional_centavos !== null &&
    product.preco_promocional_centavos > 0 &&
    product.preco_promocional_centavos < product.preco_centavos;

  const unitLabel =
    product.modalidade_venda === 'UNIDADE'
      ? 'por unidade'
      : 'por kg';

  return (
    <article
      className="group bg-white border border-zinc-200 rounded-xl overflow-hidden flex flex-col transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
    >
      {/* Product image */}
      <div
        onClick={() => onSelect(product)}
        className="relative aspect-[4/3] bg-[#F5F2EB] overflow-hidden cursor-pointer"
      >
        {product.imagem_principal && !imgFailed ? (
          <img
            src={product.imagem_principal}
            alt={product.nome}
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className={`w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02] ${
              isOut ? 'opacity-65 grayscale-[30%]' : ''
            }`}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-zinc-400 p-4 text-center bg-gradient-to-br from-[#F5F2EB] to-[#E9F2EC]">
            <Package className="w-8 h-8 mb-2 text-[#143824]/40" />
            <span className="text-xs font-medium text-zinc-500">{product.nome}</span>
          </div>
        )}
      </div>

      {/* Card body with consistent field order */}
      <div className="p-5 flex-1 flex flex-col">
        {/* Clean unboxed metadata (Zero-Pill discipline) */}
        <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-1.5">
          <span className="uppercase tracking-wide font-medium text-zinc-600">
            {product.categoria_nome || 'Agropecuária'}
          </span>
          <span aria-hidden="true">·</span>
          <span className={isOut ? 'text-red-700 font-medium' : 'text-[#143824] font-medium'}>
            {isOut ? 'Esgotado' : 'Em estoque'}
          </span>
          {hasPromo && !isOut && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-[#1f5135] font-semibold">Oferta</span>
            </>
          )}
        </div>

        <h3
          onClick={() => onSelect(product)}
          className="text-base font-semibold text-zinc-900 leading-snug mb-1.5 cursor-pointer hover:text-[#143824]"
        >
          {product.nome}
        </h3>

        {/* Short observation visible directly on catalog card */}
        <p className="text-sm text-zinc-600 leading-relaxed line-clamp-2 mb-4 flex-1">
          {product.observacao_curta}
        </p>

        {/* Price + Action baseline */}
        <div className="pt-3 border-t border-zinc-100 flex items-center justify-between gap-3">
          <div>
            {hasPromo && (
              <div className="text-xs text-zinc-400 line-through font-mono-tabular">
                {formatBRL(product.preco_centavos)}
              </div>
            )}
            <div className="text-base font-bold text-zinc-900 font-mono-tabular">
              {formatBRL(product.preco_vigente_centavos)}
              <span className="text-xs font-normal text-zinc-500 ml-1">{unitLabel}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onSelect(product)}
            className="px-4 py-2 text-xs font-semibold rounded-lg border border-[#143824] text-[#143824] hover:bg-[#143824] hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Ver detalhes
          </button>
        </div>
      </div>
    </article>
  );
}
