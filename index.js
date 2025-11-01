/**
 * index.js
 * Proxy para BullEx: login (REST + fallback SSID) e proxy WebSocket por cliente.
 *
 * Dependências:
 *   npm i express http socket.io ws node-fetch express-rate-limit
 *
 * Use em ambiente Node 18+ (ou ajuste fetch).
 */

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: [ 'https://seu-frontend.com', 'http://localhost:3000' ], // ajuste
    methods: ['GET','POST'],
  },
});

const PORT = process.env.PORT || 3000;
const BULL_EX_LOGIN = 'https://trade.bull-ex.com/v2/login';
const BULL_EX_WS = 'wss://ws.trade.bull-ex.com/echo/websocket';

// --- Config de Rate Limit para o endpoint de login (evita brute force) ---
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10, // por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Muitas tentativas, tente mais tarde.' },
});

// --- Helper: tenta login REST com headers "convincente" e retries ---
async function tryRestLogin(email, password, attempts = 3) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Origin': 'https://trade.bull-ex.com',
    'Referer': 'https://trade.bull-ex.com/login',
    // 'x-device-id': deviceId, // opcional: passe se tiver
    // 'x-platform-id': '189',
  };

  const body = JSON.stringify({ email, password });

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(BULL_EX_LOGIN, {
        method: 'POST',
        headers,
        body,
      });

      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }

      if (res.ok && json && json.ssid) {
        return { success: true, ssid: json.ssid, raw: json };
      }

      // Se a API retornar 4xx/5xx examinamos o corpo — pode indicar bloqueio/antibot
      const status = res.status;
      const snippet = (text || '').slice(0, 500);
      return { success: false, blocked: true, status, body: snippet };

    } catch (err) {
      // retry com exponential backoff
      if (attempt < attempts - 1) {
        const delay = 200 * Math.pow(2, attempt); // 200ms, 400ms, 800ms
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return { success: false, error: err.message };
    }
  }
}

// --- Helper: validar SSID abrindo WebSocket e enviando authenticate ---
async function validateSsidViaWs(ssid, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let resolved = false;
    const ws = new WebSocket(BULL_EX_WS, { handshakeTimeout: timeoutMs });

    const cleanup = () => {
      try { ws.terminate(); } catch(e) {}
    };

    const finish = (ok, info = null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ valid: ok, info });
    };

    const timer = setTimeout(() => {
      finish(false, { reason: 'timeout' });
    }, timeoutMs);

    ws.on('open', () => {
      // mensagem de autenticação observada no tráfego do navegador:
      const msg = {
        name: "authenticate",
        msg: {
          ssid: ssid,
          protocol: 3,
          client_session_id: ""
        }
      };
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        finish(false, { reason: 'send_error', error: e.message });
      }
    });

    ws.on('message', (data) => {
      // aguarda por {name: "authenticated", msg: true, client_session_id: "..."}
      let parsed = null;
      try { parsed = JSON.parse(data.toString()); } catch(e) { parsed = null; }
      if (parsed && parsed.name === 'authenticated' && parsed.msg === true) {
        clearTimeout(timer);
        finish(true, { client_session_id: parsed.client_session_id || null });
      } else {
        // poderia tratar outros casos (por exemplo erro de auth), mas aguardamos timeout
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      finish(false, { reason: 'ws_error', error: err?.message });
    });

    ws.on('close', () => {
      // se não autenticou até aqui, falha
    });
  });
}

// --- Endpoint: /auth/login ---
// Aceita { email, password } ou { ssid }
app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password, ssid } = req.body;

    if (ssid) {
      // validação direta por WS
      const v = await validateSsidViaWs(ssid, 5000);
      if (v.valid) {
        return res.json({ success: true, ssid, validated: true, info: v.info });
      } else {
        return res.status(401).json({ success: false, validated: false, message: 'SSID inválido ou expirado', info: v.info });
      }
    }

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'email e password ou ssid são necessários' });
    }

    const result = await tryRestLogin(email, password, 3);

    if (result.success) {
      return res.json({ success: true, ssid: result.ssid, raw: result.raw });
    }

    // Se falhou automaticamente ou foi bloqueado -> retornar need_manual para frontend exibir instruções
    return res.status(403).json({
      success: false,
      need_manual: true,
      message: 'Autenticação via API REST bloqueada ou falhou. Cole o SSID manualmente.',
      details: {
        status: result.status || null,
        error: result.error || null,
        snippet: result.body || null,
      }
    });

  } catch (err) {
    console.error('[/auth/login] erro interno:', err);
    return res.status(500).json({ success: false, message: 'erro interno' });
  }
});

// --- Health e rota estática básica ---
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// --- Gerenciamento de conexões socket.io ---
// Por design simples: para cada cliente socket.io, abrimos um WebSocket upstream
// para BullEx após receber 'authenticate' com { ssid }.
// Mapeamos socket.id -> upstreamWs para encaminhar mensagens.
const clientUpstreams = new Map(); // socketId => { ws, ssid, lastSeen }

io.on('connection', (socket) => {
  console.log(`[SOCKET] conectado: ${socket.id}`);

  socket.on('authenticate', async (payload) => {
    try {
      const { ssid } = payload || {};
      if (!ssid) {
        socket.emit('auth_error', { message: 'ssid necessário' });
        return;
      }

      // opcional: validar curto antes de criar conexão persistente
      const valid = await validateSsidViaWs(ssid, 4000);
      if (!valid.valid) {
        socket.emit('auth_error', { message: 'SSID inválido', info: valid.info });
        return;
      }

      // Cria conexão WebSocket persistente com BullEx para este cliente
      const upstream = new WebSocket(BULL_EX_WS);

      upstream.on('open', () => {
        // enviar authenticate novamente (fluxo normal)
        const authMsg = {
          name: "authenticate",
          msg: { ssid, protocol: 3, client_session_id: "" }
        };
        upstream.send(JSON.stringify(authMsg));
      });

      upstream.on('message', (data) => {
        // repassa mensagens do BullEx para o cliente socket
        // tente parse para objeto JSON ao repassar quando possível
        let parsed = null;
        try { parsed = JSON.parse(data.toString()); } catch(e) { parsed = null; }
        socket.emit('bull_message', parsed ?? data.toString());
      });

      upstream.on('close', (code, reason) => {
        socket.emit('bull_closed', { code, reason: reason?.toString?.() ?? reason });
      });

      upstream.on('error', (err) => {
        socket.emit('bull_error', { message: err?.message });
      });

      // salvar upstream no mapa
      // se já existia uma upstream, fechamos antes
      if (clientUpstreams.has(socket.id)) {
        try { clientUpstreams.get(socket.id).ws.terminate(); } catch(e){}
      }
      clientUpstreams.set(socket.id, { ws: upstream, ssid, lastSeen: Date.now() });

      socket.emit('auth_ok', { message: 'autenticado no proxy', validated: valid.info });

    } catch (err) {
      console.error('[socket authenticate] erro', err);
      socket.emit('auth_error', { message: 'erro interno no proxy' });
    }
  });

  // Repassar mensagens do cliente para BullEx (ex: subscribe, buy, etc)
  // O cliente deve enviar { to: 'bull', msg: {...} } ou similar; aqui assumimos 'bull_send'
  socket.on('bull_send', (payload) => {
    const entry = clientUpstreams.get(socket.id);
    if (!entry || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) {
      socket.emit('bull_error', { message: 'upstream não conectado' });
      return;
    }
    try {
      // payload pode ser objeto ou string
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
      entry.ws.send(data);
    } catch (err) {
      socket.emit('bull_error', { message: 'erro ao enviar upstream', error: err.message });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[SOCKET] desconectado: ${socket.id}`, reason);
    const entry = clientUpstreams.get(socket.id);
    if (entry && entry.ws) {
      try { entry.ws.terminate(); } catch(e){}
    }
    clientUpstreams.delete(socket.id);
  });
});

// --- Iniciar servidor ---
server.listen(PORT, () => {
  console.log(`Proxy rodando na porta ${PORT}`);
  console.log(`Endpoints: /auth/login, socket.io conectado na mesma porta.`);
});
