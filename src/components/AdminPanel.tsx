import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  LayoutDashboard,
  Package,
  ShoppingBag,
  Users,
  MessageSquare,
  Settings,
  Plus,
  Upload,
  Trash2,
  Check,
  AlertTriangle,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { apiFetch, getAuthToken } from '../lib/api.ts';
import {
  DELIVERY_STATUS_LABEL,
  FINANCE_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
  formatBRL,
  formatDateTimeBR,
  formatWeight,
  maskCPF,
  maskPhone,
} from '../lib/format.ts';
import type {
  AdminDashboard,
  Category,
  ChatMessage,
  Conversation,
  ModalidadeVenda,
  Order,
  PixKeyType,
  Product,
  PublicConfig,
  User,
} from '../types.ts';

interface AdminPanelProps {
  user: User | null;
  onOpenAuth: () => void;
  onConfigUpdated: () => void;
}

type AdminTab = 'dashboard' | 'produtos' | 'pedidos' | 'clientes' | 'chat' | 'config';

export function AdminPanel({ user, onOpenAuth, onConfigUpdated }: AdminPanelProps) {
  const [tab, setTab] = useState<AdminTab>('dashboard');
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [produtos, setProdutos] = useState<Product[]>([]);
  const [categorias, setCategorias] = useState<Category[]>([]);
  const [pedidos, setPedidos] = useState<Order[]>([]);
  const [clientes, setClientes] = useState<any[]>([]);
  const [admins, setAdmins] = useState<any[]>([]);
  const [conversas, setConversas] = useState<Conversation[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [config, setConfig] = useState<PublicConfig | null>(null);

  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Product form
  const [editingProdId, setEditingProdId] = useState<string | null>(null);
  const [prodForm, setProdForm] = useState({
    nome: '',
    categoria_id: '',
    observacao_curta: '',
    descricao_completa: '',
    palavras_chave: '',
    preco_reais: '',
    preco_promocional_reais: '',
    estoque_quantidade: '10',
    estoque_baixo_limite: '5',
    unidade_venda: 'UN',
    modalidade_venda: 'UNIDADE' as ModalidadeVenda,
    precisao_pesagem: '3',
    destaque: false,
    oferta: false,
  });
  const [pendingFiles, setPendingFiles] = useState<FileList | null>(null);
  const [newCategoryName, setNewCategoryName] = useState('');

  // Admin / Client creation forms
  const [newAdminForm, setNewAdminForm] = useState({
    nome_completo: '',
    cpf: '',
    email: '',
    telefone: '',
    senha: '',
  });
  const [newClientForm, setNewClientForm] = useState({
    nome_completo: '',
    cpf: '',
    email: '',
    telefone: '',
    senha: '',
  });

  // Config form
  const [cfgForm, setCfgForm] = useState({
    frete_reais: '4.99',
    exibir_esgotados_catalogo: true,
    whatsapp_loja: '5511999999999',
    precisao_pesagem_padrao: '3',
    pix_key_type: 'CPF' as PixKeyType,
    pix_key: '',
    pix_recipient_name: 'Agro Marconato Agropecuária',
  });

  async function loadAllAdminData() {
    if (!user || user.papel !== 'ADMIN') return;
    try {
      const [dash, prods, cats, orders, clis, adms, convs, pubCfg, admCfg] = await Promise.all([
        apiFetch<AdminDashboard>('/api/admin/dashboard'),
        apiFetch<Product[]>('/api/admin/produtos'),
        apiFetch<Category[]>('/api/categorias'),
        apiFetch<Order[]>('/api/admin/pedidos'),
        apiFetch<any[]>('/api/admin/clientes'),
        apiFetch<any[]>('/api/admin/administradores'),
        apiFetch<Conversation[]>('/api/conversas'),
        apiFetch<PublicConfig>('/api/config/public'),
        apiFetch<any>('/api/admin/configuracoes'),
      ]);
      setDashboard(dash);
      setProdutos(prods);
      setCategorias(cats);
      setPedidos(orders);
      setClientes(clis);
      setAdmins(adms);
      setConversas(convs);
      setConfig(pubCfg);
      setCfgForm({
        frete_reais: ((admCfg?.frete_padrao_centavos ?? pubCfg.frete_padrao_centavos) / 100).toFixed(2),
        exibir_esgotados_catalogo: admCfg?.exibir_esgotados_catalogo ?? pubCfg.exibir_esgotados_catalogo,
        whatsapp_loja: admCfg?.whatsapp_loja || pubCfg.whatsapp_loja,
        precisao_pesagem_padrao: String(admCfg?.precisao_pesagem_padrao ?? pubCfg.precisao_pesagem_padrao),
        pix_key_type: (admCfg?.pix_key_type || 'CPF') as PixKeyType,
        pix_key:
          admCfg?.pix_key_type === 'CPF' && admCfg?.pix_key
            ? maskCPF(admCfg.pix_key)
            : admCfg?.pix_key || '',
        pix_recipient_name: admCfg?.pix_recipient_name || 'Agro Marconato Agropecuária',
      });
      if (!prodForm.categoria_id && cats.length > 0) {
        setProdForm((f) => ({ ...f, categoria_id: cats[0].id }));
      }
    } catch (err: any) {
      setError(err?.message || 'Falha ao carregar dados administrativos.');
    }
  }

  useEffect(() => {
    loadAllAdminData();
  }, [user]);

  useEffect(() => {
    if (!activeChatId) return;
    apiFetch<ChatMessage[]>(`/api/conversas/${activeChatId}/mensagens`).then(setChatMessages);
  }, [activeChatId]);

  // WebSocket listener for real-time admin chat & order updates
  useEffect(() => {
    if (!user || user.papel !== 'ADMIN') return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const tok = getAuthToken();
    const qs = tok ? `?token=${encodeURIComponent(tok)}` : '';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws${qs}`);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'message:new' && data.message) {
          const msg: ChatMessage = data.message;
          if (msg.conversa_id === activeChatId) {
            setChatMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          }
          apiFetch<Conversation[]>('/api/conversas').then(setConversas);
        }
        if (data.type === 'order:updated') {
          apiFetch<Order[]>('/api/admin/pedidos').then(setPedidos);
          apiFetch<AdminDashboard>('/api/admin/dashboard').then(setDashboard);
          if (data.pedido?.numero_pedido) {
            showNotice(`Pedido #${data.pedido.numero_pedido} atualizado em tempo real (${FINANCE_STATUS_LABEL[data.pedido.situacao_financeira] || data.pedido.situacao_financeira}).`);
          }
        }
      } catch {
        // ignore
      }
    };
    return () => ws.close();
  }, [user, activeChatId]);

  if (!user || user.papel !== 'ADMIN') {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-4">
        <ShieldCheck className="w-10 h-10 text-[#143824] mx-auto" />
        <h1 className="text-2xl font-bold text-zinc-900">Painel Administrativo</h1>
        <p className="text-sm text-zinc-600">
          Área restrita a administradores autenticados da Agro Marconato Agropecuária.
        </p>
        <button
          type="button"
          onClick={onOpenAuth}
          className="px-5 py-2.5 bg-[#143824] text-white text-sm font-semibold rounded-lg cursor-pointer"
        >
          Entrar como Administrador
        </button>
      </div>
    );
  }

  function showNotice(msg: string) {
    setFeedback(msg);
    setError(null);
    setTimeout(() => setFeedback(null), 4000);
  }

  async function handleSaveProduct(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const precoCentavos = Math.round(Number(prodForm.preco_reais.replace(',', '.')) * 100);
      const promoCentavos = prodForm.preco_promocional_reais
        ? Math.round(Number(prodForm.preco_promocional_reais.replace(',', '.')) * 100)
        : null;

      const body = {
        nome: prodForm.nome,
        categoria_id: prodForm.categoria_id,
        observacao_curta: prodForm.observacao_curta,
        descricao_completa: prodForm.descricao_completa,
        palavras_chave: prodForm.palavras_chave,
        preco_centavos: precoCentavos,
        preco_promocional_centavos: promoCentavos,
        estoque_quantidade: Number(prodForm.estoque_quantidade),
        estoque_baixo_limite: Number(prodForm.estoque_baixo_limite),
        unidade_venda: prodForm.unidade_venda,
        modalidade_venda: prodForm.modalidade_venda,
        precisao_pesagem: Number(prodForm.precisao_pesagem),
        permite_parcelamento: false,
        max_parcelas_produto: 1,
        destaque: prodForm.destaque,
        oferta: prodForm.oferta,
      };

      let savedProd: Product;
      if (editingProdId) {
        savedProd = await apiFetch<Product>(`/api/admin/produtos/${editingProdId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        savedProd = await apiFetch<Product>('/api/admin/produtos', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }

      if (pendingFiles && pendingFiles.length > 0) {
        const fd = new FormData();
        Array.from(pendingFiles).forEach((f) => fd.append('imagens', f));
        await apiFetch(`/api/admin/produtos/${savedProd.id}/imagens`, {
          method: 'POST',
          body: fd,
        });
      }

      setEditingProdId(null);
      setPendingFiles(null);
      setProdForm({
        nome: '',
        categoria_id: categorias[0]?.id || '',
        observacao_curta: '',
        descricao_completa: '',
        palavras_chave: '',
        preco_reais: '',
        preco_promocional_reais: '',
        estoque_quantidade: '10',
        estoque_baixo_limite: '5',
        unidade_venda: 'UN',
        modalidade_venda: 'UNIDADE',
        precisao_pesagem: '3',
        destaque: false,
        oferta: false,
      });
      await loadAllAdminData();
      showNotice(editingProdId ? 'Produto atualizado com sucesso.' : 'Produto cadastrado com sucesso.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao salvar produto.');
    }
  }

  function startEditProduct(p: Product) {
    setEditingProdId(p.id);
    setProdForm({
      nome: p.nome,
      categoria_id: p.categoria_id,
      observacao_curta: p.observacao_curta,
      descricao_completa: p.descricao_completa,
      palavras_chave: p.palavras_chave,
      preco_reais: (p.preco_centavos / 100).toFixed(2),
      preco_promocional_reais: p.preco_promocional_centavos
        ? (p.preco_promocional_centavos / 100).toFixed(2)
        : '',
      estoque_quantidade: String(p.estoque_quantidade),
      estoque_baixo_limite: String(p.estoque_baixo_limite),
      unidade_venda: p.unidade_venda,
      modalidade_venda: p.modalidade_venda,
      precisao_pesagem: String(p.precisao_pesagem),
      destaque: p.destaque === 1,
      oferta: p.oferta === 1,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleUploadExtraImage(produtoId: string, e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append('imagens', f));
    try {
      await apiFetch(`/api/admin/produtos/${produtoId}/imagens`, { method: 'POST', body: fd });
      await loadAllAdminData();
      showNotice('Imagem enviada para o servidor.');
    } catch (err: any) {
      setError(err?.message || 'Erro no upload de imagem.');
    }
  }

  async function handleUpdateStock(produtoId: string, estoque: number) {
    try {
      await apiFetch(`/api/admin/produtos/${produtoId}/estoque`, {
        method: 'PATCH',
        body: JSON.stringify({ estoque_quantidade: estoque }),
      });
      await loadAllAdminData();
      showNotice('Estoque atualizado.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao atualizar estoque.');
    }
  }

  async function handleAddCategory(e: FormEvent) {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    try {
      await apiFetch('/api/admin/categorias', {
        method: 'POST',
        body: JSON.stringify({ nome: newCategoryName.trim() }),
      });
      setNewCategoryName('');
      await loadAllAdminData();
      showNotice('Categoria cadastrada.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao criar categoria.');
    }
  }

  async function handleUpdateOrderStatus(pedidoId: string, situacao_entrega: string) {
    try {
      await apiFetch(`/api/admin/pedidos/${pedidoId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ situacao_entrega }),
      });
      await loadAllAdminData();
      showNotice('Status de entrega atualizado.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao atualizar pedido.');
    }
  }

  async function handleQuitarDinheiro(pedidoId: string) {
    try {
      await apiFetch(`/api/admin/pedidos/${pedidoId}/quitar-dinheiro`, { method: 'POST' });
      await loadAllAdminData();
      showNotice('Pagamento em dinheiro confirmado como pago.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao quitar pagamento.');
    }
  }

  async function handleCreateAdmin(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/admin/administradores', {
        method: 'POST',
        body: JSON.stringify(newAdminForm),
      });
      setNewAdminForm({ nome_completo: '', cpf: '', email: '', telefone: '', senha: '' });
      await loadAllAdminData();
      showNotice('Novo administrador cadastrado.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao cadastrar administrador.');
    }
  }

  async function handleCreateClient(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/admin/clientes', {
        method: 'POST',
        body: JSON.stringify(newClientForm),
      });
      setNewClientForm({ nome_completo: '', cpf: '', email: '', telefone: '', senha: '' });
      await loadAllAdminData();
      showNotice('Cliente cadastrado pelo painel administrativo.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao cadastrar cliente.');
    }
  }

  async function handleSaveConfig(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/admin/configuracoes', {
        method: 'PUT',
        body: JSON.stringify({
          frete_padrao_centavos: Math.round(Number(cfgForm.frete_reais.replace(',', '.')) * 100),
          exibir_esgotados_catalogo: cfgForm.exibir_esgotados_catalogo,
          whatsapp_loja: cfgForm.whatsapp_loja.replace(/\D/g, ''),
          precisao_pesagem_padrao: Number(cfgForm.precisao_pesagem_padrao),
          pix_key_type: cfgForm.pix_key_type,
          pix_key: cfgForm.pix_key,
          pix_recipient_name: cfgForm.pix_recipient_name,
        }),
      });
      onConfigUpdated();
      await loadAllAdminData();
      showNotice('Configurações de recebimento Pix e loja atualizadas.');
    } catch (err: any) {
      setError(err?.message || 'Erro ao salvar configurações.');
    }
  }

  async function handleSendAdminMessage(e: FormEvent) {
    e.preventDefault();
    if (!chatDraft.trim() || !activeChatId) return;
    const text = chatDraft.trim();
    setChatDraft('');
    const saved = await apiFetch<ChatMessage>(`/api/conversas/${activeChatId}/mensagens`, {
      method: 'POST',
      body: JSON.stringify({ conteudo: text }),
    });
    setChatMessages((prev) => (prev.some((m) => m.id === saved.id) ? prev : [...prev, saved]));
  }

  const tabs: { id: AdminTab; label: string; icon: any }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'produtos', label: 'Produtos e Estoque', icon: Package },
    { id: 'pedidos', label: 'Pedidos', icon: ShoppingBag },
    { id: 'clientes', label: 'Clientes e Admins', icon: Users },
    { id: 'chat', label: 'Conversas', icon: MessageSquare },
    { id: 'config', label: 'Configurações', icon: Settings },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Painel Administrativo — Agro Marconato</h1>
          <p className="text-sm text-zinc-600">
            Gestão completa de catálogo, imagens, estoque, pedidos, pagamentos, clientes e atendimento.
          </p>
        </div>
      </div>

      {/* Sub-navigation */}
      <div className="flex flex-wrap gap-1.5 p-1 bg-zinc-100 rounded-xl w-fit">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                active ? 'bg-white text-[#143824] shadow-sm' : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {feedback && (
        <div className="p-3.5 rounded-lg bg-[#e9f2ec] border border-[#143824]/20 text-sm text-[#143824] flex items-center gap-2">
          <Check className="w-4 h-4" />
          <span>{feedback}</span>
        </div>
      )}
      {error && (
        <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}

      {/* TAB 1: DASHBOARD */}
      {tab === 'dashboard' && dashboard && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="p-5 border border-zinc-200 rounded-xl bg-white">
              <div className="text-xs font-medium text-zinc-500">Total de vendas pagas</div>
              <div className="text-2xl font-bold text-[#143824] mt-1 font-mono-tabular">
                {formatBRL(dashboard.total_vendas_centavos)}
              </div>
            </div>
            <div className="p-5 border border-zinc-200 rounded-xl bg-white">
              <div className="text-xs font-medium text-zinc-500">Quantidade de pedidos</div>
              <div className="text-2xl font-bold text-zinc-900 mt-1 font-mono-tabular">
                {dashboard.quantidade_pedidos}
              </div>
            </div>
            <div className="p-5 border border-zinc-200 rounded-xl bg-white">
              <div className="text-xs font-medium text-zinc-500">Aguardando pagamento</div>
              <div className="text-2xl font-bold text-amber-800 mt-1 font-mono-tabular">
                {dashboard.pedidos_aguardando_pagamento}
              </div>
            </div>
            <div className="p-5 border border-zinc-200 rounded-xl bg-white">
              <div className="text-xs font-medium text-zinc-500">Em preparação</div>
              <div className="text-2xl font-bold text-zinc-900 mt-1 font-mono-tabular">
                {dashboard.pedidos_em_preparacao}
              </div>
            </div>
            <div className="p-5 border border-zinc-200 rounded-xl bg-white">
              <div className="text-xs font-medium text-zinc-500">Enviados / Saiu para entrega</div>
              <div className="text-2xl font-bold text-zinc-900 mt-1 font-mono-tabular">
                {dashboard.pedidos_enviados}
              </div>
            </div>
            <div className="p-5 border border-zinc-200 rounded-xl bg-white">
              <div className="text-xs font-medium text-zinc-500">Entregues</div>
              <div className="text-2xl font-bold text-[#143824] mt-1 font-mono-tabular">
                {dashboard.pedidos_entregues}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="border border-zinc-200 rounded-xl p-5 bg-white space-y-3">
              <h3 className="text-sm font-semibold text-zinc-900">Produtos com estoque baixo</h3>
              {dashboard.produtos_estoque_baixo.length === 0 ? (
                <p className="text-xs text-zinc-500">Nenhum produto abaixo do limite configurado.</p>
              ) : (
                <div className="divide-y divide-zinc-100">
                  {dashboard.produtos_estoque_baixo.map((p) => (
                    <div key={p.id} className="py-2 flex items-center justify-between text-sm">
                      <span className="text-zinc-800">{p.nome}</span>
                      <span className="font-mono-tabular text-amber-800 font-semibold">
                        {p.estoque_quantidade} {p.unidade_venda}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border border-zinc-200 rounded-xl p-5 bg-white space-y-3">
              <h3 className="text-sm font-semibold text-zinc-900">Produtos esgotados</h3>
              {dashboard.produtos_esgotados.length === 0 ? (
                <p className="text-xs text-zinc-500">Nenhum produto esgotado no momento.</p>
              ) : (
                <div className="divide-y divide-zinc-100">
                  {dashboard.produtos_esgotados.map((p) => (
                    <div key={p.id} className="py-2 flex items-center justify-between text-sm">
                      <span className="text-zinc-800">{p.nome}</span>
                      <span className="text-xs font-semibold text-red-700">Esgotado</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: PRODUTOS E ESTOQUE */}
      {tab === 'produtos' && (
        <div className="space-y-8">
          {/* Categories inline creator */}
          <form onSubmit={handleAddCategory} className="p-4 border border-zinc-200 rounded-xl bg-[#FAFBF9] flex flex-wrap items-center gap-3">
            <span className="text-xs font-semibold text-zinc-700">Nova categoria:</span>
            <input
              type="text"
              placeholder="Ex.: Higiene e Pet"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              className="px-3 py-1.5 text-sm bg-white border border-zinc-300 rounded-lg"
            />
            <button
              type="submit"
              className="px-3.5 py-1.5 bg-[#143824] text-white text-xs font-semibold rounded-lg inline-flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Adicionar categoria</span>
            </button>
          </form>

          {/* Create / Edit product form */}
          <form onSubmit={handleSaveProduct} className="border border-zinc-200 rounded-xl p-6 bg-white space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-zinc-900">
                {editingProdId ? 'Editar produto' : 'Cadastrar novo produto'}
              </h2>
              {editingProdId && (
                <button
                  type="button"
                  onClick={() => setEditingProdId(null)}
                  className="text-xs text-zinc-600 hover:underline cursor-pointer"
                >
                  Cancelar edição
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Nome do produto</label>
                <input
                  type="text"
                  required
                  value={prodForm.nome}
                  onChange={(e) => setProdForm({ ...prodForm, nome: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Categoria</label>
                <select
                  value={prodForm.categoria_id}
                  onChange={(e) => setProdForm({ ...prodForm, categoria_id: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
                >
                  {categorias.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nome}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Modalidade de venda</label>
                <select
                  value={prodForm.modalidade_venda}
                  onChange={(e) =>
                    setProdForm({
                      ...prodForm,
                      modalidade_venda: e.target.value as ModalidadeVenda,
                      unidade_venda: e.target.value === 'UNIDADE' ? 'UN' : 'KG',
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
                >
                  <option value="UNIDADE">Por unidade</option>
                  <option value="PESO_KG">Por quilo (kg)</option>
                  <option value="VALOR_DINHEIRO">Por valor em dinheiro (R$)</option>
                  <option value="PESO_E_VALOR">Por quilo (kg) e valor em dinheiro (R$)</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                Observação curta (exibida diretamente no card do catálogo)
              </label>
              <input
                type="text"
                required
                value={prodForm.observacao_curta}
                onChange={(e) => setProdForm({ ...prodForm, observacao_curta: e.target.value })}
                placeholder="Ex.: Mistura especial de sementes para alimentação diária."
                className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">Descrição completa</label>
              <textarea
                required
                rows={3}
                value={prodForm.descricao_completa}
                onChange={(e) => setProdForm({ ...prodForm, descricao_completa: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
              />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Preço (R$)</label>
                <input
                  type="text"
                  required
                  placeholder="18.00"
                  value={prodForm.preco_reais}
                  onChange={(e) => setProdForm({ ...prodForm, preco_reais: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Preço oferta (R$)</label>
                <input
                  type="text"
                  placeholder="Opcional"
                  value={prodForm.preco_promocional_reais}
                  onChange={(e) => setProdForm({ ...prodForm, preco_promocional_reais: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Estoque inicial</label>
                <input
                  type="number"
                  step="0.001"
                  required
                  value={prodForm.estoque_quantidade}
                  onChange={(e) => setProdForm({ ...prodForm, estoque_quantidade: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Precisão pesagem</label>
                <input
                  type="number"
                  min={0}
                  max={3}
                  value={prodForm.precisao_pesagem}
                  onChange={(e) => setProdForm({ ...prodForm, precisao_pesagem: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Palavras-chave para pesquisa</label>
                <input
                  type="text"
                  value={prodForm.palavras_chave}
                  onChange={(e) => setProdForm({ ...prodForm, palavras_chave: e.target.value })}
                  placeholder="passarinho ave calopsita semente"
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">
                  Enviar fotos do dispositivo (JPG, PNG ou WEBP, máx. 5MB)
                </label>
                <input
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => setPendingFiles(e.target.files)}
                  className="w-full text-xs text-zinc-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-[#e9f2ec] file:text-[#143824] file:font-semibold"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-6 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={prodForm.destaque}
                  onChange={(e) => setProdForm({ ...prodForm, destaque: e.target.checked })}
                />
                <span>Produto em destaque</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={prodForm.oferta}
                  onChange={(e) => setProdForm({ ...prodForm, oferta: e.target.checked })}
                />
                <span>Em oferta</span>
              </label>
            </div>

            <button
              type="submit"
              className="px-5 py-2.5 bg-[#143824] hover:bg-[#1f5135] text-white text-sm font-semibold rounded-lg cursor-pointer"
            >
              {editingProdId ? 'Salvar alterações' : 'Cadastrar produto'}
            </button>
          </form>

          {/* Products table */}
          <div className="border border-zinc-200 rounded-xl bg-white overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-[#FAFBF9] border-b border-zinc-200 text-xs text-zinc-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Produto</th>
                  <th className="px-4 py-3">Preço</th>
                  <th className="px-4 py-3">Estoque</th>
                  <th className="px-4 py-3">Situação</th>
                  <th className="px-4 py-3">Imagens</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {produtos.map((p) => (
                  <tr key={p.id} className="hover:bg-zinc-50/70">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-zinc-900">{p.nome}</div>
                      <div className="text-xs text-zinc-500">{p.categoria_nome} · {p.modalidade_venda}</div>
                    </td>
                    <td className="px-4 py-3 font-mono-tabular">
                      {formatBRL(p.preco_vigente_centavos)} / {p.unidade_venda}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          step="0.1"
                          defaultValue={p.estoque_quantidade}
                          onBlur={(e) => {
                            const val = Number(e.target.value);
                            if (!Number.isNaN(val) && val !== p.estoque_quantidade) {
                              handleUpdateStock(p.id, val);
                            }
                          }}
                          className="w-20 px-2 py-1 text-xs border border-zinc-300 rounded font-mono-tabular"
                        />
                        <span className="text-xs text-zinc-500">{p.unidade_venda}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs font-semibold ${
                          p.situacao === 'DISPONIVEL' ? 'text-[#143824]' : 'text-red-700'
                        }`}
                      >
                        {p.situacao}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {p.imagens.map((img) => (
                          <div key={img.id} className="relative group w-9 h-9 rounded overflow-hidden border border-zinc-200">
                            <img src={img.url} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            <button
                              type="button"
                              onClick={async () => {
                                await apiFetch(`/api/admin/produtos/${p.id}/imagens/${img.id}`, {
                                  method: 'DELETE',
                                });
                                loadAllAdminData();
                              }}
                              title="Excluir imagem"
                              className="absolute inset-0 bg-black/60 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center cursor-pointer"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                        <label className="w-9 h-9 rounded border border-dashed border-zinc-300 flex items-center justify-center text-zinc-500 hover:border-[#143824] cursor-pointer">
                          <Upload className="w-3.5 h-3.5" />
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            multiple
                            className="hidden"
                            onChange={(e) => handleUploadExtraImage(p.id, e)}
                          />
                        </label>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => startEditProduct(p)}
                        className="text-xs font-semibold text-[#143824] hover:underline cursor-pointer"
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/admin/produtos/${p.id}`, { method: 'DELETE' });
                          loadAllAdminData();
                          showNotice('Produto removido/inativado.');
                        }}
                        className="text-xs font-semibold text-red-700 hover:underline cursor-pointer"
                      >
                        Excluir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: PEDIDOS */}
      {tab === 'pedidos' && (
        <div className="space-y-4">
          {pedidos.length === 0 ? (
            <div className="p-10 text-center border border-zinc-200 rounded-xl text-sm text-zinc-500">
              Nenhum pedido registrado ainda.
            </div>
          ) : (
            pedidos.map((o) => (
              <div key={o.id} className="border border-zinc-200 rounded-xl bg-white p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-100 pb-3">
                  <div>
                    <div className="text-sm font-bold text-zinc-900 font-mono-tabular">
                      Pedido #{o.numero_pedido} · {o.cliente_nome}
                    </div>
                    <div className="text-xs text-zinc-500 font-mono-tabular">
                      CPF: {maskCPF(o.cliente_cpf || '')} · Tel: {maskPhone(o.cliente_telefone || '')} ·{' '}
                      {formatDateTimeBR(o.criado_em)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-base font-bold text-[#143824] font-mono-tabular">
                      {formatBRL(o.total_centavos)}
                    </div>
                    <div className="text-xs text-zinc-600">
                      {PAYMENT_METHOD_LABEL[o.forma_pagamento]} ·{' '}
                      <strong>{FINANCE_STATUS_LABEL[o.situacao_financeira]}</strong>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                  <div className="md:col-span-2 space-y-1">
                    {o.itens.map((it) => (
                      <div key={it.id} className="flex justify-between text-zinc-700">
                        <span>
                          {it.nome_produto_snapshot} (
                          {it.modo_compra === 'UNIDADE'
                            ? `${it.quantidade} un.`
                            : `${formatWeight(it.quantidade, 3)} kg`}
                          )
                        </span>
                        <span className="font-mono-tabular">{formatBRL(it.subtotal_centavos)}</span>
                      </div>
                    ))}
                    <div className="pt-1 text-zinc-500">
                      Endereço: {o.endereco_rua}, {o.endereco_numero} — {o.endereco_bairro}, {o.endereco_cidade}/
                      {o.endereco_estado} (CEP {o.endereco_cep})
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="block font-medium text-zinc-700">Atualizar status da entrega</label>
                    <select
                      value={o.situacao_entrega}
                      onChange={(e) => handleUpdateOrderStatus(o.id, e.target.value)}
                      className="w-full px-3 py-2 text-xs border border-zinc-300 rounded-lg"
                    >
                      {Object.entries(DELIVERY_STATUS_LABEL).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>

                    {o.forma_pagamento === 'DINHEIRO_NA_ENTREGA' &&
                      o.situacao_financeira === 'AGUARDANDO_PAGAMENTO' && (
                        <button
                          type="button"
                          onClick={() => handleQuitarDinheiro(o.id)}
                          className="w-full py-2 px-3 bg-[#143824] text-white text-xs font-semibold rounded-lg cursor-pointer"
                        >
                          Confirmar recebimento em dinheiro
                        </button>
                      )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* TAB 4: CLIENTES E ADMINISTRADORES */}
      {tab === 'clientes' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <form onSubmit={handleCreateClient} className="border border-zinc-200 rounded-xl p-5 bg-white space-y-3">
              <h3 className="text-sm font-semibold text-zinc-900">Cadastrar cliente</h3>
              <input
                type="text"
                required
                placeholder="Nome completo"
                value={newClientForm.nome_completo}
                onChange={(e) => setNewClientForm({ ...newClientForm, nome_completo: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  placeholder="CPF"
                  value={newClientForm.cpf}
                  onChange={(e) => setNewClientForm({ ...newClientForm, cpf: maskCPF(e.target.value) })}
                  className="px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                />
                <input
                  type="text"
                  required
                  placeholder="Telefone"
                  value={newClientForm.telefone}
                  onChange={(e) => setNewClientForm({ ...newClientForm, telefone: maskPhone(e.target.value) })}
                  className="px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                />
              </div>
              <input
                type="email"
                required
                placeholder="E-mail"
                value={newClientForm.email}
                onChange={(e) => setNewClientForm({ ...newClientForm, email: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
              />
              <input
                type="password"
                required
                placeholder="Senha inicial forte"
                value={newClientForm.senha}
                onChange={(e) => setNewClientForm({ ...newClientForm, senha: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
              />
              <button type="submit" className="px-4 py-2 bg-[#143824] text-white text-xs font-semibold rounded-lg cursor-pointer">
                Cadastrar cliente
              </button>
            </form>

            <div className="border border-zinc-200 rounded-xl p-5 bg-white space-y-3">
              <h3 className="text-sm font-semibold text-zinc-900">Clientes registrados ({clientes.length})</h3>
              <div className="divide-y divide-zinc-100 max-h-80 overflow-y-auto text-xs">
                {clientes.map((c) => (
                  <div key={c.id} className="py-2.5 flex justify-between">
                    <div>
                      <div className="font-semibold text-zinc-900">{c.nome_completo}</div>
                      <div className="text-zinc-500 font-mono-tabular">
                        {maskCPF(c.cpf)} · {c.email}
                      </div>
                    </div>
                    <span className="font-mono-tabular text-zinc-700">{c.total_pedidos} pedidos</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <form onSubmit={handleCreateAdmin} className="border border-zinc-200 rounded-xl p-5 bg-white space-y-3">
              <h3 className="text-sm font-semibold text-zinc-900">Cadastrar novo administrador (restrito)</h3>
              <input
                type="text"
                required
                placeholder="Nome completo"
                value={newAdminForm.nome_completo}
                onChange={(e) => setNewAdminForm({ ...newAdminForm, nome_completo: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  placeholder="CPF"
                  value={newAdminForm.cpf}
                  onChange={(e) => setNewAdminForm({ ...newAdminForm, cpf: maskCPF(e.target.value) })}
                  className="px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                />
                <input
                  type="text"
                  required
                  placeholder="Telefone"
                  value={newAdminForm.telefone}
                  onChange={(e) => setNewAdminForm({ ...newAdminForm, telefone: maskPhone(e.target.value) })}
                  className="px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                />
              </div>
              <input
                type="email"
                required
                placeholder="E-mail corporativo"
                value={newAdminForm.email}
                onChange={(e) => setNewAdminForm({ ...newAdminForm, email: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
              />
              <input
                type="password"
                required
                placeholder="Senha forte"
                value={newAdminForm.senha}
                onChange={(e) => setNewAdminForm({ ...newAdminForm, senha: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg"
              />
              <button type="submit" className="px-4 py-2 bg-[#143824] text-white text-xs font-semibold rounded-lg cursor-pointer">
                Criar administrador
              </button>
            </form>

            <div className="border border-zinc-200 rounded-xl p-5 bg-white space-y-3">
              <h3 className="text-sm font-semibold text-zinc-900">Administradores ({admins.length})</h3>
              <div className="divide-y divide-zinc-100 text-xs">
                {admins.map((a) => (
                  <div key={a.id} className="py-2.5">
                    <div className="font-semibold text-zinc-900">{a.nome_completo}</div>
                    <div className="text-zinc-500 font-mono-tabular">
                      {maskCPF(a.cpf)} · {a.email}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: CONVERSAS (ADMIN CHAT INBOX) */}
      {tab === 'chat' && (
        <div className="grid grid-cols-1 md:grid-cols-3 border border-zinc-200 rounded-xl overflow-hidden bg-white min-h-[500px]">
          <div className="border-b md:border-b-0 md:border-r border-zinc-200 bg-[#FAFBF9] divide-y divide-zinc-200">
            {conversas.length === 0 ? (
              <p className="p-4 text-xs text-zinc-500">Nenhuma conversa recebida.</p>
            ) : (
              conversas.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setActiveChatId(c.id)}
                  className={`w-full text-left p-4 cursor-pointer ${
                    activeChatId === c.id ? 'bg-[#e9f2ec]' : 'hover:bg-zinc-100'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-zinc-900">{c.cliente_nome}</span>
                    {c.nao_lidas ? (
                      <span className="text-[11px] font-bold text-[#143824] font-mono-tabular">
                        {c.nao_lidas} nova(s)
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-zinc-600 mt-0.5">{c.assunto}</div>
                  {c.ultima_mensagem && (
                    <div className="text-xs text-zinc-400 truncate mt-1">{c.ultima_mensagem}</div>
                  )}
                </button>
              ))
            )}
          </div>

          <div className="md:col-span-2 flex flex-col h-[500px]">
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {!activeChatId ? (
                <p className="text-center text-xs text-zinc-500 py-16">
                  Selecione uma conversa ao lado para responder ao cliente.
                </p>
              ) : (
                chatMessages.map((m) => {
                  const isAdmin = m.remetente_papel === 'ADMIN';
                  return (
                    <div key={m.id} className={`flex flex-col ${isAdmin ? 'items-end' : 'items-start'}`}>
                      <div
                        className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm ${
                          isAdmin ? 'bg-[#143824] text-white' : 'bg-[#F5F2EB] text-zinc-900'
                        }`}
                      >
                        <div className="text-[11px] opacity-75 mb-0.5">{m.remetente_nome}</div>
                        <p className="whitespace-pre-wrap">{m.conteudo}</p>
                      </div>
                      <span className="text-[11px] text-zinc-400 mt-1 font-mono-tabular">
                        {formatDateTimeBR(m.criado_em)}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
            {activeChatId && (
              <form onSubmit={handleSendAdminMessage} className="p-4 border-t border-zinc-200 flex gap-2">
                <input
                  type="text"
                  value={chatDraft}
                  onChange={(e) => setChatDraft(e.target.value)}
                  placeholder="Responder ao cliente..."
                  className="flex-1 px-3.5 py-2 text-sm border border-zinc-300 rounded-lg"
                />
                <button
                  type="submit"
                  className="px-4 py-2 bg-[#143824] text-white text-sm font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                  <span>Enviar</span>
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* TAB 6: CONFIGURAÇÕES E INTEGRAÇÕES */}
      {tab === 'config' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <form onSubmit={handleSaveConfig} className="border border-zinc-200 rounded-xl p-6 bg-white space-y-5">
            <div>
              <h3 className="text-base font-semibold text-zinc-900">Recebimento PIX (Chave do Administrador), Frete e WhatsApp</h3>
              <p className="text-xs text-zinc-500 mt-1">
                Cadastre o CPF/Chave Pix de destino dos recebimentos (ex.: Nubank). O checkout consulta esta chave antes de gerar o PIX.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-[#FAFBF9] border border-zinc-200 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Tipo da Chave Pix</label>
                  <select
                    value={cfgForm.pix_key_type}
                    onChange={(e) => setCfgForm({ ...cfgForm, pix_key_type: e.target.value as PixKeyType, pix_key: '' })}
                    className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-lg"
                  >
                    <option value="CPF">CPF (ex.: Nubank)</option>
                    <option value="CNPJ">CNPJ</option>
                    <option value="EMAIL">E-mail</option>
                    <option value="TELEFONE">Telefone</option>
                    <option value="EVP">Chave Aleatória (EVP)</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Chave Pix do Recebedor</label>
                  <input
                    type="text"
                    placeholder={
                      cfgForm.pix_key_type === 'CPF'
                        ? '000.000.000-00'
                        : cfgForm.pix_key_type === 'TELEFONE'
                        ? '(11) 99999-9999'
                        : cfgForm.pix_key_type === 'EMAIL'
                        ? 'financeiro@agromarconato.com.br'
                        : 'Informe sua chave Pix'
                    }
                    value={cfgForm.pix_key}
                    onChange={(e) => {
                      const val =
                        cfgForm.pix_key_type === 'CPF'
                          ? maskCPF(e.target.value)
                          : cfgForm.pix_key_type === 'TELEFONE'
                          ? maskPhone(e.target.value)
                          : e.target.value;
                      setCfgForm({ ...cfgForm, pix_key: val });
                    }}
                    className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-lg font-mono-tabular"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Nome do Titular da Chave Pix</label>
                <input
                  type="text"
                  required
                  value={cfgForm.pix_recipient_name}
                  onChange={(e) => setCfgForm({ ...cfgForm, pix_recipient_name: e.target.value })}
                  className="w-full px-3 py-2 text-sm bg-white border border-zinc-300 rounded-lg"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Frete padrão único (R$)</label>
                <input
                  type="text"
                  value={cfgForm.frete_reais}
                  onChange={(e) => setCfgForm({ ...cfgForm, frete_reais: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">WhatsApp da loja (DDI+DDD+Número)</label>
                <input
                  type="text"
                  value={cfgForm.whatsapp_loja}
                  onChange={(e) => setCfgForm({ ...cfgForm, whatsapp_loja: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Casas decimais (pesagem)</label>
                <input
                  type="number"
                  min={0}
                  max={3}
                  value={cfgForm.precisao_pesagem_padrao}
                  onChange={(e) => setCfgForm({ ...cfgForm, precisao_pesagem_padrao: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg font-mono-tabular"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={cfgForm.exibir_esgotados_catalogo}
                onChange={(e) => setCfgForm({ ...cfgForm, exibir_esgotados_catalogo: e.target.checked })}
              />
              <span>Continuar exibindo produtos esgotados no catálogo (com compra bloqueada)</span>
            </label>
            <button
              type="submit"
              className="px-5 py-2.5 bg-[#143824] text-white text-sm font-semibold rounded-lg cursor-pointer"
            >
              Salvar configurações
            </button>
          </form>

          <div className="border border-zinc-200 rounded-xl p-6 bg-[#FAFBF9] space-y-3 text-xs text-zinc-700">
            <h3 className="text-base font-semibold text-zinc-900">Integrações externas de produção</h3>
            <p>
              <strong>Banco de Dados e Storage:</strong>{' '}
              {config?.database_engine === 'supabase'
                ? `Conectado ao Supabase (${config.supabase_url}). Tabelas PostgreSQL e Storage de imagens ativos.`
                : 'Rodando em SQLite local. Para vincular ao seu Supabase, execute supabase/schema.sql no SQL Editor do Supabase e adicione SUPABASE_URL e SUPABASE_SECRET_KEY nas variáveis de ambiente.'}
            </p>
            <p>
              <strong>Mercado Pago:</strong>{' '}
              {config?.mercado_pago_configurado
                ? 'Credenciais ativas no servidor.'
                : 'Configure MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_PUBLIC_KEY e MERCADOPAGO_WEBHOOK_SECRET no ambiente. Aponte o webhook para /api/webhooks/mercadopago.'}
            </p>
            <p>
              <strong>ViaCEP:</strong> Ativo automaticamente no checkout para preenchimento por CEP.
            </p>
            <p>
              <strong>E-mail transacional (SMTP):</strong> Configure <code>SMTP_HOST</code>, <code>SMTP_USER</code> e{' '}
              <code>SMTP_PASS</code> para envio real de códigos de confirmação e recuperação de senha.
            </p>
            <p>
              <strong>SMS / WhatsApp API:</strong> Configure <code>WHATSAPP_CLOUD_TOKEN</code> ou{' '}
              <code>TWILIO_ACCOUNT_SID</code> para confirmação automática de telefone.
            </p>
            <p>
              <strong>Verificação de titularidade de CPF:</strong> Configure <code>CPF_VERIFICATION_API_URL</code> e{' '}
              <code>CPF_VERIFICATION_API_KEY</code> para consulta cadastral em tempo real.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
