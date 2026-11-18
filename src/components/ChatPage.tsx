import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Send, MessageSquare } from 'lucide-react';
import { apiFetch, getAuthToken } from '../lib/api.ts';
import { formatDateTimeBR } from '../lib/format.ts';
import type { ChatMessage, Conversation, User } from '../types.ts';

interface ChatPageProps {
  user: User | null;
  initialPedidoId?: string | null;
  onOpenAuth: () => void;
}

export function ChatPage({ user, initialPedidoId, onOpenAuth }: ChatPageProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [wsConnected, setWsConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }

    async function init() {
      setLoading(true);
      try {
        if (user?.papel === 'CLIENTE') {
          const conv = await apiFetch<Conversation>('/api/conversas', {
            method: 'POST',
            body: JSON.stringify({ pedidoId: initialPedidoId || null }),
          });
          const list = await apiFetch<Conversation[]>('/api/conversas');
          setConversations(list);
          setActiveConvId(conv.id);
        } else {
          const list = await apiFetch<Conversation[]>('/api/conversas');
          setConversations(list);
          if (list.length > 0) setActiveConvId(list[0].id);
        }
      } finally {
        setLoading(false);
      }
    }

    init();
  }, [user, initialPedidoId]);

  useEffect(() => {
    if (!activeConvId || !user) return;
    apiFetch<ChatMessage[]>(`/api/conversas/${activeConvId}/mensagens`)
      .then(setMessages)
      .catch(() => {});
  }, [activeConvId, user]);

  // Real-time WebSocket connection with automatic reconnect
  useEffect(() => {
    if (!user) return;
    let closedByEffect = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const tok = getAuthToken();
      const qs = tok ? `?token=${encodeURIComponent(tok)}` : '';
      const socket = new WebSocket(`${proto}//${window.location.host}/ws${qs}`);
      wsRef.current = socket;

      socket.onopen = () => {
        setWsConnected(true);
        if (activeConvId) {
          socket.send(JSON.stringify({ type: 'conversation:join', conversaId: activeConvId }));
        }
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'message:new' && data.message) {
            const incoming: ChatMessage = data.message;
            setMessages((prev) => {
              if (incoming.conversa_id !== activeConvId) return prev;
              // Idempotency guard against duplicate broadcasts
              if (prev.some((m) => m.id === incoming.id)) return prev;
              return [...prev, incoming];
            });
            setConversations((prev) =>
              prev.map((c) =>
                c.id === incoming.conversa_id
                  ? { ...c, ultima_mensagem: incoming.conteudo, ultima_mensagem_em: incoming.criado_em }
                  : c
              )
            );
          }
        } catch {
          // ignore malformed frame
        }
      };

      socket.onclose = () => {
        setWsConnected(false);
        if (!closedByEffect) {
          reconnectTimer = setTimeout(connect, 2500);
        }
      };
    }

    connect();

    return () => {
      closedByEffect = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [user, activeConvId]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !activeConvId) return;
    setDraft('');

    // Use REST endpoint which also broadcasts to all connected WebSocket listeners reliably
    try {
      const saved = await apiFetch<ChatMessage>(`/api/conversas/${activeConvId}/mensagens`, {
        method: 'POST',
        body: JSON.stringify({ conteudo: text }),
      });
      setMessages((prev) => (prev.some((m) => m.id === saved.id) ? prev : [...prev, saved]));
    } catch (err) {
      setDraft(text);
    }
  }

  if (!user) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-20 text-center space-y-4">
        <MessageSquare className="w-10 h-10 text-[#143824] mx-auto" />
        <h1 className="text-2xl font-bold text-zinc-900">Atendimento direto</h1>
        <p className="text-sm text-zinc-600">
          Faça login com seu CPF e senha para conversar em tempo real com a equipe da Agro Marconato.
        </p>
        <button
          type="button"
          onClick={onOpenAuth}
          className="px-5 py-2.5 bg-[#143824] text-white text-sm font-semibold rounded-lg cursor-pointer"
        >
          Entrar para conversar
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Atendimento Agro Marconato</h1>
          <p className="text-sm text-zinc-600">
            Tire dúvidas sobre produtos, estoque, entregas ou pedidos diretamente com nossa equipe.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-600">
          <span
            className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-600' : 'bg-zinc-300'}`}
            aria-hidden="true"
          />
          <span>{wsConnected ? 'Conectado em tempo real' : 'Reconectando...'}</span>
        </div>
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-zinc-500">Carregando conversas...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 border border-zinc-200 rounded-xl overflow-hidden bg-white min-h-[540px]">
          {/* Conversations sidebar */}
          <aside className="border-b md:border-b-0 md:border-r border-zinc-200 bg-[#FAFBF9] flex flex-col">
            <div className="px-4 py-3 border-b border-zinc-200 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Suas conversas
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-zinc-200">
              {conversations.length === 0 ? (
                <p className="p-4 text-xs text-zinc-500">Nenhuma conversa iniciada.</p>
              ) : (
                conversations.map((conv) => (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => setActiveConvId(conv.id)}
                    className={`w-full text-left p-4 transition-colors cursor-pointer ${
                      activeConvId === conv.id ? 'bg-[#e9f2ec]' : 'hover:bg-zinc-100'
                    }`}
                  >
                    <div className="text-sm font-semibold text-zinc-900 truncate">{conv.assunto}</div>
                    {conv.ultima_mensagem && (
                      <div className="text-xs text-zinc-600 truncate mt-1">{conv.ultima_mensagem}</div>
                    )}
                  </button>
                ))
              )}
            </div>
          </aside>

          {/* Messages panel */}
          <div className="md:col-span-2 flex flex-col h-[540px]">
            <div className="flex-1 overflow-y-auto p-5 space-y-3 bg-white">
              {messages.length === 0 ? (
                <div className="text-center py-16 text-xs text-zinc-500">
                  Envie uma mensagem abaixo para iniciar o atendimento.
                </div>
              ) : (
                messages.map((m) => {
                  const isMine = m.remetente_id === user.id;
                  return (
                    <div key={m.id} className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}>
                      <div
                        className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm ${
                          isMine
                            ? 'bg-[#143824] text-white'
                            : 'bg-[#F5F2EB] text-zinc-900 border border-zinc-200'
                        }`}
                      >
                        <div className="text-[11px] opacity-75 mb-0.5 font-medium">
                          {m.remetente_nome} · {m.remetente_papel === 'ADMIN' ? 'Equipe Agro Marconato' : 'Você'}
                        </div>
                        <p className="whitespace-pre-wrap leading-relaxed">{m.conteudo}</p>
                      </div>
                      <span className="text-[11px] text-zinc-400 mt-1 font-mono-tabular">
                        {formatDateTimeBR(m.criado_em)}
                      </span>
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            <form onSubmit={handleSend} className="p-4 border-t border-zinc-200 bg-[#FAFBF9] flex gap-2">
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Digite sua dúvida ou mensagem..."
                className="flex-1 px-4 py-2.5 text-sm bg-white border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#143824]"
              />
              <button
                type="submit"
                disabled={!draft.trim() || !activeConvId}
                className="px-4 py-2.5 bg-[#143824] hover:bg-[#1f5135] disabled:opacity-50 text-white text-sm font-medium rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Send className="w-4 h-4" />
                <span>Enviar</span>
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
