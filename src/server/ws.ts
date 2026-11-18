import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { extractTokenFromWsRequest, verifySessionToken, type SessionUser } from './auth.ts';
import { addConversationMessageRepo, listConversationsRepo } from './store-repo-orders.ts';

interface AuthedSocket extends WebSocket {
  user?: SessionUser;
  subscribedConversations?: Set<string>;
  isAlive?: boolean;
}

let wssInstance: WebSocketServer | null = null;
const connectedClients = new Set<AuthedSocket>();

export function setupWebSocketServer(httpServer: HttpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wssInstance = wss;

  wss.on('connection', (ws: AuthedSocket, req) => {
    const token = extractTokenFromWsRequest(req);
    const user = token ? verifySessionToken(token) : null;

    if (!user) {
      ws.send(JSON.stringify({ type: 'error', error: 'Sessão não autenticada.' }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    ws.user = user;
    ws.subscribedConversations = new Set();
    ws.isAlive = true;
    connectedClients.add(ws);

    ws.send(
      JSON.stringify({
        type: 'connected',
        user: { id: user.id, papel: user.papel, nome: user.nome },
      })
    );

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleSocketEvent(ws, msg).catch(() => {});
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Formato de mensagem inválido.' }));
      }
    });

    ws.on('close', () => {
      connectedClients.delete(ws);
    });
  });

  const interval = setInterval(() => {
    for (const ws of connectedClients) {
      if (ws.isAlive === false) {
        connectedClients.delete(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  wss.on('close', () => clearInterval(interval));
  return wss;
}

async function handleSocketEvent(ws: AuthedSocket, msg: any) {
  const user = ws.user;
  if (!user) return;

  if (msg.type === 'conversation:join' && msg.conversaId) {
    const convs = (await listConversationsRepo(user)) as any[];
    const allowed = convs.some((c) => c.id === msg.conversaId);
    if (!allowed) {
      ws.send(JSON.stringify({ type: 'error', error: 'Conversa não encontrada ou acesso negado.' }));
      return;
    }
    ws.subscribedConversations?.add(msg.conversaId);
    ws.send(JSON.stringify({ type: 'conversation:joined', conversaId: msg.conversaId }));
    return;
  }

  if (msg.type === 'message:send' && msg.conversaId && typeof msg.conteudo === 'string') {
    const conteudo = msg.conteudo.trim();
    if (!conteudo || conteudo.length > 2000) return;

    const result = await addConversationMessageRepo(msg.conversaId, user, conteudo, msg.pedidoId);
    if (result.message && result.clienteId) {
      broadcastChatMessage(result.clienteId, result.message);
    }
  }
}

export function broadcastChatMessage(clienteId: string, message: any) {
  if (!wssInstance) return;
  const frame = JSON.stringify({ type: 'message:new', message });
  for (const client of connectedClients) {
    if (client.readyState !== WebSocket.OPEN || !client.user) continue;
    const isAdmin = client.user.papel === 'ADMIN';
    const isOwner = client.user.papel === 'CLIENTE' && client.user.id === clienteId;
    if (isAdmin || isOwner) {
      client.send(frame);
    }
  }
}

export function broadcastOrderUpdate(clienteId: string, pedido: any) {
  if (!wssInstance) return;
  const frame = JSON.stringify({ type: 'order:updated', pedido });
  for (const client of connectedClients) {
    if (client.readyState !== WebSocket.OPEN || !client.user) continue;
    const isAdmin = client.user.papel === 'ADMIN';
    const isOwner = client.user.papel === 'CLIENTE' && client.user.id === clienteId;
    if (isAdmin || isOwner) {
      client.send(frame);
    }
  }
}
