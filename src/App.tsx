import { useEffect, useState, useCallback, type FormEvent } from 'react';
import { Search, SlidersHorizontal, ArrowRight } from 'lucide-react';
import { apiFetch, setAuthToken } from './lib/api.ts';
import { formatBRL } from './lib/format.ts';
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
import { AuthGateScreen } from './components/AuthGateScreen.tsx';
import { ProductCard } from './components/ProductCard.tsx';
import { ProductModal } from './components/ProductModal.tsx';
import { CartDrawer } from './components/CartDrawer.tsx';
import { CheckoutModal } from './components/CheckoutModal.tsx';
import { MyOrdersPage } from './components/MyOrdersPage.tsx';
import { ChatPage } from './components/ChatPage.tsx';
import { AdminPanel } from './components/AdminPanel.tsx';
import { WhatsAppButton } from './components/WhatsAppButton.tsx';

const EMPTY_CART: CartState = {
  carrinho_id: null,
  itens: [],
  subtotal_centavos: 0,
  frete_centavos: 0,
  total_centavos: 0,
};

const DEFAULT_CONFIG: PublicConfig = {
  frete_padrao_centavos: 499,
  max_parcelas: 1,
  parcelas_sem_juros: 1,
  taxa_juros_mensal: 0,
  exibir_esgotados_catalogo: true,
  whatsapp_loja: '5511999999999',
  precisao_pesagem_padrao: 3,
  mercado_pago_public_key: '',
  mercado_pago_configurado: false,
};

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

  const [authModalMode, setAuthModalMode] = useState<'login' | 'register' | 'recovery' | 'verify' | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [cart, setCart] = useState<CartState>(EMPTY_CART);
  const [chatOrderId, setChatOrderId] = useState<string | null>(null);

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
    if (!u || u.papel !== 'CLIENTE') {
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
    apiFetch<{ user: User | null }>('/api/auth/me')
      .then((res) => {
        setUser(res.user);
        if (res.user) {
          loadCategories();
          loadCart(res.user);
        } else {
          setAuthToken(null);
        }
      })
      .catch(() => {
        setAuthToken(null);
      })
      .finally(() => setAuthChecked(true));
  }, [loadConfig, loadCategories, loadCart]);

  useEffect(() => {
    const onExpired = () => {
      setAuthToken(null);
      setUser(null);
      setCart(EMPTY_CART);
      setProducts([]);
      setCategories([]);
    };
    window.addEventListener('agro:session-expired', onExpired);
    return () => window.removeEventListener('agro:session-expired', onExpired);
  }, []);

  const loadProducts = useCallback(async () => {
    if (!user) return;
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
  }, [user, appliedQuery, selectedCategory, availabilityFilter, maxPriceFilter, currentPath]);

  useEffect(() => {
    if (user && (currentPath === '/' || currentPath === '/ofertas')) {
      loadProducts();
    }
  }, [user, currentPath, loadProducts]);

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault();
    setAppliedQuery(searchInput.trim());
  }

  async function handleAddToCart(payload: {
    produtoId: string;
    modoCompra: ModoCompra;
    quantidade?: number;
    valorDesejadoCentavos?: number;
  }) {
    if (!user) {
      setSelectedProduct(null);
      return;
    }
    if (user.papel === 'ADMIN') {
      throw new Error('Contas de administrador não realizam compras. Entre com uma conta de cliente.');
    }
    const nextCart = await apiFetch<CartState>('/api/carrinho/itens', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setCart(nextCart);
    setCartOpen(true);
  }

  async function handleUpdateCartItem(
    item: CartItem,
    nextValue: { quantidade?: number; valorDesejadoCentavos?: number }
  ) {
    const nextCart = await apiFetch<CartState>(`/api/carrinho/itens/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ modoCompra: item.modo_compra, ...nextValue }),
    });
    setCart(nextCart);
  }

  async function handleRemoveCartItem(itemId: string) {
    const nextCart = await apiFetch<CartState>(`/api/carrinho/itens/${itemId}`, {
      method: 'DELETE',
    });
    setCart(nextCart);
  }

  async function handleLogout() {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setAuthToken(null);
    setUser(null);
    setCart(EMPTY_CART);
    setProducts([]);
    setCategories([]);
  }

  // Wait for initial session check
  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FAFBF9] text-sm text-zinc-500">
        Carregando Agro Marconato...
      </div>
    );
  }

  // Mandatory Auth Gate: nothing of the store appears before login or registration
  if (!user) {
    return (
      <AuthGateScreen
        isAdminRoute={currentPath === '/admin'}
        onNavigate={navigate}
        onAuthenticated={(u) => {
          setUser(u);
          loadCategories();
          loadCart(u);
          if (u.papel === 'ADMIN' && currentPath === '/') {
            navigate('/admin');
          }
        }}
      />
    );
  }

  const showCatalog = currentPath === '/' || currentPath === '/ofertas';

  return (
    <div className="min-h-screen flex flex-col bg-white text-zinc-900">
      <Navbar
        currentPath={currentPath}
        onNavigate={navigate}
        user={user}
        cartCount={cart.itens.length}
        onOpenCart={() => setCartOpen(true)}
        onOpenAuth={(mode = 'login') => setAuthModalMode(mode)}
        onLogout={handleLogout}
      />

      <main className="flex-1">
        {showCatalog && (
          <>
            {currentPath === '/' && (
              <section className="border-b border-zinc-200 bg-[#FAFBF9]">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-14 grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
                  <div className="lg:col-span-6 flex flex-col justify-center space-y-5">
                    <p className="text-xs font-semibold uppercase tracking-widest text-[#143824]">
                      Agro Marconato Agropecuária
                    </p>
                    <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-zinc-900 tracking-tight leading-[1.12] [text-wrap:balance]">
                      Nutrição animal, sementes e insumos com precisão do campo à sua casa.
                    </h1>
                    <p className="text-base text-zinc-600 leading-relaxed max-w-xl">
                      Compre por unidade, por quilo exato ou informando o valor em reais que deseja
                      levar. Entrega ágil, pagamento via PIX, cartão de crédito à vista ou na entrega.
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
                    Frete padrão: {formatBRL(config.frete_padrao_centavos)}
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

              {loadingProducts ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {[1, 2, 3].map((n) => (
                    <div key={n} className="h-80 rounded-xl bg-zinc-100 animate-pulse" />
                  ))}
                </div>
              ) : products.length === 0 ? (
                <div className="py-16 text-center border border-zinc-200 rounded-xl bg-[#FAFBF9] space-y-2">
                  <p className="text-base font-semibold text-zinc-800">Nenhum produto cadastrado ou encontrado</p>
                  <p className="text-sm text-zinc-500">
                    {user.papel === 'ADMIN'
                      ? 'Acesse /admin para cadastrar os produtos reais da sua loja.'
                      : 'Tente ajustar os termos de busca ou limpar os filtros selecionados.'}
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

        {currentPath === '/admin' && (
          <AdminPanel
            user={user}
            onOpenAuth={() => setAuthModalMode('login')}
            onConfigUpdated={loadConfig}
          />
        )}
      </main>

      <footer className="border-t border-zinc-200 bg-[#FAFBF9] mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div>
            <div className="text-base font-bold text-[#143824] font-display">
              Agro Marconato Agropecuária
            </div>
            <p className="text-xs text-zinc-500 mt-1">
              Rações, sementes, produtos veterinários e ferramentas para sua propriedade.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-6 text-xs text-zinc-600">
            <button type="button" onClick={() => navigate('/')} className="hover:text-[#143824] cursor-pointer">
              Catálogo
            </button>
            <button type="button" onClick={() => navigate('/meus-pedidos')} className="hover:text-[#143824] cursor-pointer">
              Meus Pedidos
            </button>
            <button type="button" onClick={() => navigate('/atendimento')} className="hover:text-[#143824] cursor-pointer">
              Atendimento
            </button>
            {user.papel === 'ADMIN' && (
              <button type="button" onClick={() => navigate('/admin')} className="hover:text-[#143824] cursor-pointer">
                Painel Admin
              </button>
            )}
            <span className="text-zinc-400">© {new Date().getFullYear()} Agro Marconato</span>
          </div>
        </div>
      </footer>

      <WhatsAppButton whatsappNumber={config.whatsapp_loja} />

      {authModalMode && (
        <AuthModal
          initialMode={authModalMode}
          user={user}
          onClose={() => setAuthModalMode(null)}
          onAuthenticated={(u) => {
            setUser(u);
            loadCart(u);
          }}
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
          setCheckoutOpen(true);
        }}
      />

      {checkoutOpen && (
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
