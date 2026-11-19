import { useEffect, useState, useCallback, type FormEvent } from 'react';
import { Search, SlidersHorizontal, ArrowRight } from 'lucide-react';
import { apiFetch, setAuthToken } from './lib/api.ts';
import { formatBRL } from './lib/format.ts';
import { getSupabaseBrowserClient, isFrontendSupabaseConfigured } from './lib/supabase.ts';
import type {
  CartItem,
  CartState,
  Category,
  ModoCompra,
  Product,
  PublicConfig,
  User,
} from './types.ts';
import { Navbar } from './components/Navbar.tsx';
import { AuthModal } from './components/AuthModal.tsx';
import { ProductCard } from './components/ProductCard.tsx';
import { ProductModal } from './components/ProductModal.tsx';
import { CartDrawer } from './components/CartDrawer.tsx';
import { CheckoutModal } from './components/CheckoutModal.tsx';
import { MyOrdersPage } from './components/MyOrdersPage.tsx';
import { ChatPage } from './components/ChatPage.tsx';
import { AdminPanel } from './components/AdminPanel.tsx';
import { WhatsAppButton } from './components/WhatsAppButton.tsx';

const GUEST_CART_KEY = 'agro_marconato_guest_cart_v1';
const FIXED_SHIPPING_CENTAVOS = 499;

const EMPTY_CART: CartState = {
  carrinho_id: null,
  itens: [],
  subtotal_centavos: 0,
  frete_centavos: 0,
  total_centavos: 0,
};

const DEFAULT_CONFIG: PublicConfig = {
  frete_padrao_centavos: FIXED_SHIPPING_CENTAVOS,
  max_parcelas: 1,
  parcelas_sem_juros: 1,
  taxa_juros_mensal: 0,
  exibir_esgotados_catalogo: true,
  whatsapp_loja: '5511999999999',
  precisao_pesagem_padrao: 3,
  mercado_pago_public_key: '',
  mercado_pago_configurado: false,
};

function computeGuestCartTotals(itens: CartItem[]): CartState {
  const subtotal = itens.reduce((acc, it) => acc + Number(it.subtotal_centavos), 0);
  const frete = itens.length > 0 ? FIXED_SHIPPING_CENTAVOS : 0;
  return {
    carrinho_id: 'guest',
    itens,
    subtotal_centavos: subtotal,
    frete_centavos: frete,
    total_centavos: subtotal + frete,
  };
}

function readGuestCartFromStorage(): CartState {
  try {
    const raw = localStorage.getItem(GUEST_CART_KEY);
    if (!raw) return EMPTY_CART;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_CART;
    return computeGuestCartTotals(parsed);
  } catch {
    return EMPTY_CART;
  }
}

function writeGuestCartToStorage(itens: CartItem[]): CartState {
  if (itens.length === 0) {
    localStorage.removeItem(GUEST_CART_KEY);
    return EMPTY_CART;
  }
  localStorage.setItem(GUEST_CART_KEY, JSON.stringify(itens));
  return computeGuestCartTotals(itens);
}

export default function App() {
  const [currentPath, setCurrentPath] = useState<string>(() => window.location.pathname || '/');
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [config, setConfig] = useState<PublicConfig>(DEFAULT_CONFIG);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);

  const [searchInput, setSearchInput] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [availabilityFilter, setAvailabilityFilter] = useState('');
  const [maxPriceFilter, setMaxPriceFilter] = useState('');

  const [authModalMode, setAuthModalMode] = useState<'login' | 'register' | null>(null);
  const [pendingCheckoutAfterAuth, setPendingCheckoutAfterAuth] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [cart, setCart] = useState<CartState>(() => readGuestCartFromStorage());
  const [chatOrderId, setChatOrderId] = useState<string | null>(null);

  const isAdmin = Boolean(user?.is_admin || user?.papel === 'ADMIN');

  useEffect(() => {
    const onPopState = () => setCurrentPath(window.location.pathname || '/');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((path: string) => {
    if (path !== window.location.pathname) {
      window.history.pushState({}, '', path);
    }
    setCurrentPath(path);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await apiFetch<PublicConfig>('/api/config/public');
      setConfig(cfg);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadCategories = useCallback(async () => {
    try {
      const cats = await apiFetch<Category[]>('/api/categorias');
      setCategories(cats);
    } catch {
      setCategories([]);
    }
  }, []);

  const loadCart = useCallback(async (u: User | null) => {
    if (!u) {
      setCart(readGuestCartFromStorage());
      return;
    }
    if (u.is_admin || u.papel === 'ADMIN') {
      setCart(EMPTY_CART);
      return;
    }
    try {
      const c = await apiFetch<CartState>('/api/carrinho');
      setCart(c);
    } catch {
      setCart(EMPTY_CART);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    loadCategories();
    apiFetch<{ user: User | null }>('/api/auth/me')
      .then((res) => {
        setUser(res.user);
        if (res.user) {
          loadCart(res.user);
          if ((res.user.is_admin || res.user.papel === 'ADMIN') && window.location.pathname === '/') {
            navigate('/admin');
          }
        } else {
          setAuthToken(null);
          setCart(readGuestCartFromStorage());
        }
      })
      .catch(() => {
        setAuthToken(null);
        setCart(readGuestCartFromStorage());
      })
      .finally(() => setAuthChecked(true));
  }, [loadConfig, loadCategories, loadCart, navigate]);

  useEffect(() => {
    const onExpired = () => {
      setAuthToken(null);
      setUser(null);
      setCart(readGuestCartFromStorage());
    };
    window.addEventListener('agro:session-expired', onExpired);
    return () => window.removeEventListener('agro:session-expired', onExpired);
  }, []);

  const loadProducts = useCallback(async () => {
    setLoadingProducts(true);
    try {
      const params = new URLSearchParams();
      if (appliedQuery) params.set('q', appliedQuery);
      if (selectedCategory) params.set('categoria', selectedCategory);
      if (availabilityFilter) params.set('disponibilidade', availabilityFilter);
      if (maxPriceFilter) params.set('precoMax', maxPriceFilter);
      if (currentPath === '/ofertas') params.set('ofertas', 'true');

      const rows = await apiFetch<Product[]>(`/api/produtos?${params.toString()}`);
      setProducts(rows);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingProducts(false);
    }
  }, [appliedQuery, selectedCategory, availabilityFilter, maxPriceFilter, currentPath]);

  useEffect(() => {
    if (currentPath === '/' || currentPath === '/ofertas' || (!isAdmin && currentPath === '/admin')) {
      loadProducts();
    }
  }, [currentPath, isAdmin, loadProducts]);

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault();
    setAppliedQuery(searchInput.trim());
  }

  async function handleAddToCart(payload: {
    product: Product;
    produtoId: string;
    modoCompra: ModoCompra;
    quantidade: number;
  }) {
    if (isAdmin) {
      throw new Error('Contas de administrador gerenciam a loja e não realizam compras.');
    }

    if (user) {
      const nextCart = await apiFetch<CartState>('/api/carrinho/itens', {
        method: 'POST',
        body: JSON.stringify({
          produtoId: payload.produtoId,
          modoCompra: payload.modoCompra,
          quantidade: payload.quantidade,
        }),
      });
      setCart(nextCart);
      setCartOpen(true);
      return;
    }

    // Guest cart persisted in localStorage
    const p = payload.product;
    const isKg = p.unit_type === 'kg' || p.modalidade_venda === 'PESO_KG';
    const precisao = isKg ? p.precisao_pesagem || 3 : 0;
    const precoUnit = p.preco_vigente_centavos;
    const current = readGuestCartFromStorage().itens;

    const existingIdx = current.findIndex(
      (it) => it.produto_id === p.id && it.modo_compra === payload.modoCompra
    );

    const nextItems = [...current];
    if (existingIdx >= 0) {
      const prev = nextItems[existingIdx];
      const nextQty = isKg
        ? Number((prev.quantidade + payload.quantidade).toFixed(precisao))
        : Math.floor(prev.quantidade + payload.quantidade);
      if (nextQty > p.estoque_quantidade) {
        throw new Error(`Estoque insuficiente. Disponível: ${p.estoque_quantidade} ${isKg ? 'kg' : 'un.'}`);
      }
      nextItems[existingIdx] = {
        ...prev,
        quantidade: nextQty,
        subtotal_centavos: Math.round(nextQty * precoUnit),
      };
    } else {
      if (payload.quantidade > p.estoque_quantidade) {
        throw new Error(`Estoque insuficiente. Disponível: ${p.estoque_quantidade} ${isKg ? 'kg' : 'un.'}`);
      }
      nextItems.push({
        id: `guest-${p.id}-${payload.modoCompra}`,
        carrinho_id: 'guest',
        produto_id: p.id,
        produto_nome: p.nome,
        observacao_curta: p.observacao_curta,
        unit_type: isKg ? 'kg' : 'un',
        unidade_venda: isKg ? 'KG' : 'UN',
        modalidade_venda: isKg ? 'PESO_KG' : 'UNIDADE',
        precisao_pesagem: precisao,
        estoque_quantidade: p.estoque_quantidade,
        situacao: p.situacao,
        modo_compra: payload.modoCompra,
        quantidade: payload.quantidade,
        valor_desejado_centavos: null,
        preco_unitario_snapshot_centavos: precoUnit,
        subtotal_centavos: Math.round(payload.quantidade * precoUnit),
        imagem_principal: p.imagem_principal,
        max_parcelas_produto: 1,
      });
    }

    setCart(writeGuestCartToStorage(nextItems));
    setCartOpen(true);
  }

  async function handleUpdateCartItem(item: CartItem, nextValue: { quantidade: number }) {
    if (user) {
      const nextCart = await apiFetch<CartState>(`/api/carrinho/itens/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ modoCompra: item.modo_compra, quantidade: nextValue.quantidade }),
      });
      setCart(nextCart);
      return;
    }

    const isKg = item.unit_type === 'kg' || item.modo_compra === 'PESO_KG';
    const nextQty = isKg
      ? Number(Number(nextValue.quantidade).toFixed(item.precisao_pesagem || 3))
      : Math.floor(Number(nextValue.quantidade));
    if (nextQty <= 0) {
      await handleRemoveCartItem(item.id);
      return;
    }
    const clampedQty = Math.min(nextQty, item.estoque_quantidade);
    const current = readGuestCartFromStorage().itens;
    const nextItems = current.map((it) =>
      it.id === item.id
        ? {
            ...it,
            quantidade: clampedQty,
            subtotal_centavos: Math.round(clampedQty * it.preco_unitario_snapshot_centavos),
          }
        : it
    );
    setCart(writeGuestCartToStorage(nextItems));
  }

  async function handleRemoveCartItem(itemId: string) {
    if (user) {
      const nextCart = await apiFetch<CartState>(`/api/carrinho/itens/${itemId}`, {
        method: 'DELETE',
      });
      setCart(nextCart);
      return;
    }

    const current = readGuestCartFromStorage().itens;
    setCart(writeGuestCartToStorage(current.filter((it) => it.id !== itemId)));
  }

  async function handleAuthenticated(u: User) {
    setUser(u);
    const adminUser = Boolean(u.is_admin || u.papel === 'ADMIN');

    if (adminUser) {
      setPendingCheckoutAfterAuth(false);
      setCart(EMPTY_CART);
      navigate('/admin');
      return;
    }

    const guestState = readGuestCartFromStorage();
    if (guestState.itens.length > 0) {
      for (const item of guestState.itens) {
        try {
          await apiFetch('/api/carrinho/itens', {
            method: 'POST',
            body: JSON.stringify({
              produtoId: item.produto_id,
              modoCompra: item.modo_compra,
              quantidade: item.quantidade,
            }),
          });
        } catch {
          // Skip item if out of stock during merge
        }
      }
      localStorage.removeItem(GUEST_CART_KEY);
    }

    await loadCart(u);

    if (pendingCheckoutAfterAuth) {
      setPendingCheckoutAfterAuth(false);
      setCheckoutOpen(true);
    }
  }

  async function handleLogout() {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    if (isFrontendSupabaseConfigured()) {
      await getSupabaseBrowserClient()?.auth.signOut().catch(() => {});
    }
    setAuthToken(null);
    setUser(null);
    setPendingCheckoutAfterAuth(false);
    setCart(readGuestCartFromStorage());
    if (currentPath === '/admin') {
      navigate('/');
    }
  }

  // Only show admin panel when authenticated user explicitly has is_admin === true
  const showAdminView = isAdmin && currentPath === '/admin';
  const showCatalog =
    currentPath === '/' ||
    currentPath === '/ofertas' ||
    (!isAdmin && currentPath === '/admin');

  return (
    <div className="min-h-screen flex flex-col bg-white text-zinc-900">
      <Navbar
        currentPath={showCatalog && currentPath === '/admin' ? '/' : currentPath}
        onNavigate={navigate}
        user={user}
        cartCount={cart.itens.length}
        onOpenCart={() => setCartOpen(true)}
        onOpenAuth={(mode = 'login') => {
          setPendingCheckoutAfterAuth(false);
          setAuthModalMode(mode);
        }}
        onLogout={handleLogout}
      />

      <main className="flex-1">
        {showCatalog && (
          <>
            {(currentPath === '/' || currentPath === '/admin') && (
              <section className="border-b border-zinc-200 bg-[#FAFBF9]">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-14 grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
                  <div className="lg:col-span-6 flex flex-col justify-center space-y-5">
                    <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-zinc-900 tracking-tight leading-[1.12] [text-wrap:balance]">
                      Nutrição animal, sementes e insumos com precisão do campo à sua casa.
                    </h1>
                    <p className="text-base text-zinc-600 leading-relaxed max-w-xl">
                      Frete fixo de R$ 4,99. Pagamento via PIX, cartão à vista ou na entrega.
                    </p>
                    <div className="flex flex-wrap items-center gap-4 pt-1">
                      <a
                        href="#catalogo"
                        className="inline-flex items-center gap-2 px-5 py-3 bg-[#143824] hover:bg-[#1f5135] text-white text-sm font-semibold rounded-lg transition-colors"
                      >
                        <span>Explorar catálogo</span>
                        <ArrowRight className="w-4 h-4" />
                      </a>
                      <button
                        type="button"
                        onClick={() => navigate('/ofertas')}
                        className="px-5 py-3 border border-zinc-300 hover:border-[#143824] text-zinc-800 text-sm font-semibold rounded-lg transition-colors cursor-pointer"
                      >
                        Ver ofertas da semana
                      </button>
                    </div>
                  </div>

                  <div className="lg:col-span-6">
                    <div className="aspect-[16/10] lg:h-full rounded-xl overflow-hidden border border-zinc-200 bg-[#F5F2EB]">
                      <img
                        src="/src/assets/images/hero_agro_marconato_1794877320649.jpg"
                        alt="Interior da loja Agro Marconato Agropecuária"
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    </div>
                  </div>
                </div>
              </section>
            )}

            <section id="catalogo" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-8">
              <div className="space-y-4">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-bold text-zinc-900">
                      {currentPath === '/ofertas' ? 'Ofertas especiais' : 'Catálogo de produtos'}
                    </h2>
                    <p className="text-sm text-zinc-600 mt-1">
                      Pesquise por nome, categoria ou palavra-chave.
                    </p>
                  </div>
                  <div className="text-xs text-zinc-500 font-mono-tabular">
                    Frete fixo: {formatBRL(config.frete_padrao_centavos)}
                  </div>
                </div>

                <div className="p-4 border border-zinc-200 rounded-xl bg-[#FAFBF9] space-y-4">
                  <form onSubmit={handleSearchSubmit} className="flex flex-col sm:flex-row gap-3">
                    <div className="relative flex-1">
                      <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="search"
                        value={searchInput}
                        onChange={(e) => {
                          setSearchInput(e.target.value);
                          if (!e.target.value.trim()) setAppliedQuery('');
                        }}
                        placeholder="Buscar produtos (ex.: ração de passarinho, milho, suplemento...)"
                        className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824]"
                      />
                    </div>
                    <button
                      type="submit"
                      className="px-5 py-2.5 bg-[#143824] hover:bg-[#1f5135] text-white text-sm font-semibold rounded-lg transition-colors cursor-pointer shrink-0"
                    >
                      Pesquisar
                    </button>
                  </form>

                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setSelectedCategory('')}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                          selectedCategory === ''
                            ? 'bg-[#143824] text-white'
                            : 'bg-white border border-zinc-200 text-zinc-700 hover:border-zinc-400'
                        }`}
                      >
                        Todas
                      </button>
                      {categories.map((cat) => (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => setSelectedCategory(cat.slug)}
                          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                            selectedCategory === cat.slug
                              ? 'bg-[#143824] text-white'
                              : 'bg-white border border-zinc-200 text-zinc-700 hover:border-zinc-400'
                          }`}
                        >
                          {cat.nome}
                        </button>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 text-xs">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-500" />
                      <select
                        value={availabilityFilter}
                        onChange={(e) => setAvailabilityFilter(e.target.value)}
                        className="px-3 py-1.5 bg-white border border-zinc-300 rounded-lg text-zinc-700"
                        aria-label="Filtrar disponibilidade"
                      >
                        <option value="">Todas disponibilidades</option>
                        <option value="DISPONIVEL">Em estoque</option>
                        <option value="ESGOTADO">Esgotados</option>
                      </select>
                      <select
                        value={maxPriceFilter}
                        onChange={(e) => setMaxPriceFilter(e.target.value)}
                        className="px-3 py-1.5 bg-white border border-zinc-300 rounded-lg text-zinc-700"
                        aria-label="Filtrar preço máximo"
                      >
                        <option value="">Qualquer preço</option>
                        <option value="25">Até R$ 25,00</option>
                        <option value="75">Até R$ 75,00</option>
                        <option value="150">Até R$ 150,00</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              {loadingProducts || !authChecked ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {[1, 2, 3].map((n) => (
                    <div key={n} className="h-80 rounded-xl bg-zinc-100 animate-pulse" />
                  ))}
                </div>
              ) : products.length === 0 ? (
                <div className="py-16 text-center border border-zinc-200 rounded-xl bg-[#FAFBF9] space-y-2">
                  <p className="text-base font-semibold text-zinc-800">Nenhum produto cadastrado ou encontrado</p>
                  <p className="text-sm text-zinc-500">
                    Tente ajustar os termos de busca ou limpar os filtros selecionados.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput('');
                      setAppliedQuery('');
                      setSelectedCategory('');
                      setAvailabilityFilter('');
                      setMaxPriceFilter('');
                    }}
                    className="mt-2 px-4 py-2 text-xs font-semibold text-[#143824] border border-[#143824] rounded-lg cursor-pointer"
                  >
                    Limpar filtros
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {products.map((p) => (
                    <ProductCard key={p.id} product={p} onSelect={setSelectedProduct} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {currentPath === '/meus-pedidos' && (
          <MyOrdersPage
            user={user}
            onOpenAuth={() => setAuthModalMode('login')}
            onOpenOrderChat={(pedidoId) => {
              setChatOrderId(pedidoId);
              navigate('/atendimento');
            }}
          />
        )}

        {currentPath === '/atendimento' && (
          <ChatPage
            user={user}
            initialPedidoId={chatOrderId}
            onOpenAuth={() => setAuthModalMode('login')}
          />
        )}

        {showAdminView && (
          <AdminPanel
            user={user}
            onConfigUpdated={loadConfig}
          />
        )}
      </main>

      <footer className="border-t border-zinc-200 bg-[#FAFBF9] mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div>
            <div className="text-base font-bold text-[#143824] font-display">
              Loja Oficial
            </div>
            <p className="text-xs text-zinc-500 mt-1">
              Rações, sementes, produtos veterinários e ferramentas para sua propriedade.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-6 text-xs text-zinc-600">
            <button type="button" onClick={() => navigate('/')} className="hover:text-[#143824] cursor-pointer">
              Catálogo
            </button>
            {!isAdmin && (
              <>
                <button type="button" onClick={() => navigate('/meus-pedidos')} className="hover:text-[#143824] cursor-pointer">
                  Meus Pedidos
                </button>
                <button type="button" onClick={() => navigate('/atendimento')} className="hover:text-[#143824] cursor-pointer">
                  Atendimento
                </button>
              </>
            )}
            {isAdmin && (
              <button type="button" onClick={() => navigate('/admin')} className="hover:text-[#143824] cursor-pointer">
                Gestão da Loja
              </button>
            )}
            <span className="text-zinc-400">© {new Date().getFullYear()} Loja Oficial</span>
          </div>
        </div>
      </footer>

      <WhatsAppButton whatsappNumber={config.whatsapp_loja} />

      {authModalMode && (
        <AuthModal
          initialMode={authModalMode}
          onClose={() => {
            setAuthModalMode(null);
            setPendingCheckoutAfterAuth(false);
          }}
          onAuthenticated={handleAuthenticated}
        />
      )}

      {selectedProduct && (
        <ProductModal
          product={selectedProduct}
          config={config}
          onClose={() => setSelectedProduct(null)}
          onAddToCart={handleAddToCart}
        />
      )}

      <CartDrawer
        open={cartOpen}
        cart={cart}
        onClose={() => setCartOpen(false)}
        onUpdateItem={handleUpdateCartItem}
        onRemoveItem={handleRemoveCartItem}
        onCheckout={() => {
          setCartOpen(false);
          if (!user) {
            setPendingCheckoutAfterAuth(true);
            setAuthModalMode('login');
          } else if (!isAdmin) {
            setCheckoutOpen(true);
          }
        }}
      />

      {checkoutOpen && user && !isAdmin && (
        <CheckoutModal
          cart={cart}
          config={config}
          user={user}
          onClose={() => {
            setCheckoutOpen(false);
            loadCart(user);
            loadProducts();
          }}
          onOrderCreated={() => {
            loadCart(user);
            loadProducts();
          }}
        />
      )}
    </div>
  );
}
