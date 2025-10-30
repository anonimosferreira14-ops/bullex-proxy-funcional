/**
 * Proxy BullEx - index.js (Atualizado: subscribe-active robusto)
 * - Aceita { name }, { active }, string, number
 * - Envia subscribe-candles com wrapper sendMessage/msg para compatibilidade
 * - Repassa 'subscription' e balances corretamente
 */

import express from "express";
import { Server } from "socket.io";
import cors from "cors";
import WebSocket from "ws";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Proxy BullEx ativo em 0.0.0.0:${PORT}`)
);

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

// Mapeamento (exemplo, complete com seu arquivo)
const ACTIVE_MAP = {
  "EURUSD-OTC": 76,
  "GBPUSD-OTC": 77,
  "USDJPY-OTC": 78,
  "AUDUSD-OTC": 79,
  "EURJPY-OTC": 80,
  "EURGBP-OTC": 81,
  "USDCHF-OTC": 82,
  "USDCAD-OTC": 83,
  "EURCAD-OTC": 84,
  "GBPJPY-OTC": 85,
  // ...complete conforme seu arquivo "ativos bullex.txt"
};

// Stores
const connections = new Map(); // socketId -> { ws, aggregator, ssid, user_balance_id, currentActive }
const clientBalances = new Map();

// Pequeno helper para converter formatos de subscribe-active
function resolveActivePayload(payload) {
  // payload can be:
  // - string: "EURUSD-OTC"
  // - number: 76
  // - object: { name: "EURUSD-OTC" } or { active: 76 } or { id: 76 }
  if (payload == null) return null;

  // if a string or number directly
  if (typeof payload === "string") {
    return { type: "name", value: payload };
  }
  if (typeof payload === "number") {
    return { type: "id", value: payload };
  }
  // if object wrapper
  if (typeof payload === "object") {
    // allow { name }, { active }, { id }, or entire envelope { name: 'subscribe-active', msg: { name: 'EURUSD-OTC' } }
    if (payload.name && typeof payload.name === "string") return { type: "name", value: payload.name };
    if (payload.active && typeof payload.active === "number") return { type: "id", value: payload.active };
    if (payload.id && typeof payload.id === "number") return { type: "id", value: payload.id };
    // sometimes frontend may send { msg: { name: "EURUSD-OTC" } }
    if (payload.msg && payload.msg.name && typeof payload.msg.name === "string") return { type: "name", value: payload.msg.name };
    // or payload could be { payload: "EURUSD-OTC" }
    if (payload.payload && typeof payload.payload === "string") return { type: "name", value: payload.payload };
  }
  return null;
}

// Helper wrapper to send subscribe-candles in compatible format
function sendSubscribeCandles(bullexWs, id, timeframe = "1m") {
  // Two patterns are used by different endpoints: direct {name: 'subscribe-candles', body: {...}}
  // and wrapped sendMessage -> { name: 'sendMessage', msg: { name: 'subscribe-candles', body: {...} } }
  // We will try the sendMessage wrapper first (more commonly accepted), then direct as fallback.
  try {
    const payload = {
      name: "sendMessage",
      msg: {
        name: "subscribe-candles",
        version: "1.0",
        body: { active_id: id, size: 1, at: timeframe },
      },
    };
    bullexWs.send(JSON.stringify(payload));
    // also send direct for compatibility
    bullexWs.send(JSON.stringify({ name: "subscribe-candles", version: "1.0", body: { active_id: id, size: 1, at: timeframe } }));
  } catch (e) {
    // ignore send errors
  }
}

// Basic aggregator (kept minimal)
const RATE_LIMITS = {
  "candles-generated": { interval: 400, maxEvents: 4 },
};
class EventAggregator {
  constructor() {
    this.timers = {};
  }
  send(socket, event, data) {
    if (this.timers[event]) clearTimeout(this.timers[event]);
    this.timers[event] = setTimeout(() => {
      try { socket.emit(event, data); } catch (e) {}
    }, 80);
  }
  clear() { Object.values(this.timers).forEach(clearTimeout); }
}

// Connect per client
function connectToBullEx(ssid, clientSocket) {
  const short = clientSocket.id.slice(0, 8);
  console.log(`📌 [${short}] Iniciando autenticação com BullEx...`);

  const bullexWs = new WebSocket("wss://ws.trade.bull-ex.com/echo/websocket", {
    headers: { Origin: "https://trade.bull-ex.com", "User-Agent": "Mozilla/5.0" },
  });

  const aggregator = new EventAggregator();
  connections.set(clientSocket.id, { ws: bullexWs, aggregator, ssid, user_balance_id: null, currentActive: null });

  let pingInterval = null;
  let reconnectAttempts = 0;

  bullexWs.on("open", () => {
    console.log(`✅ [${short}] Conectado à BullEx. Enviando authenticate...`);
    bullexWs.send(JSON.stringify({ name: "authenticate", msg: { ssid, protocol: 3, client_session_id: "" } }));

    // Keepalive
    pingInterval = setInterval(() => {
      if (bullexWs.readyState === WebSocket.OPEN) {
        try { bullexWs.send(JSON.stringify({ name: "ping" })); } catch (e) {}
      }
    }, 20000);
  });

  bullexWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const event = data.name || data.event || "unknown";

      if (!["ping", "pong", "timeSync"].includes(event)) console.log(`📨 [${short}] Evento: ${event}`);

      if (event === "ping") { bullexWs.send(JSON.stringify({ name: "pong" })); return; }
      if (event === "timeSync") return;

      if (event === "authenticated") {
        clientSocket.emit("authenticated", data);
        // request balances & positions
        setTimeout(() => {
          try {
            bullexWs.send(JSON.stringify({ name: "sendMessage", msg: { name: "balances.get-balances", version: "1.0", body: {} } }));
            bullexWs.send(JSON.stringify({ name: "sendMessage", msg: { name: "subscribe-positions", version: "1.0", body: {} } }));
            console.log(`💵 [${short}] Pedido de saldo/subscribe-positions enviado`);
          } catch (e) {}
        }, 700);
        return;
      }

      if (event === "balances" || event === "balance-changed") {
        let amount = null, currency = "USD", ubid = null;
        if (event === "balance-changed") {
          const cur = data?.msg?.current_balance;
          if (cur) { amount = cur.amount; currency = cur.currency || currency; ubid = cur.id || cur.user_balance_id || null; }
        } else if (event === "balances" && Array.isArray(data.msg)) {
          const pick = data.msg.find(b => b.currency === "USD") || data.msg[0];
          if (pick) { amount = pick.amount; currency = pick.currency || currency; ubid = pick.id || pick.user_balance_id || null; }
        }
        if (amount != null) {
          clientBalances.set(clientSocket.id, amount);
          const conn = connections.get(clientSocket.id);
          if (conn) conn.user_balance_id = ubid || conn.user_balance_id;
          clientSocket.emit("balance", { msg: { current_balance: { id: ubid, amount, currency } } });
          clientSocket.emit("balance-changed", { name: "balance-changed", msg: { current_balance: { id: ubid, amount, currency } } });
          clientSocket.emit("current-balance", { msg: { current_balance: { id: ubid, amount, currency, timestamp: Date.now() } } });
          console.log(`💰 [${short}] Saldo detectado: ${currency} $${(amount/100).toFixed(2)}`);
        }
        return;
      }

      if (event === "subscription") {
        // forward subscription info (some servers send this)
        clientSocket.emit("subscription", data);
        return;
      }

      if (event === "candles-generated" || event === "candle-generated") {
        aggregator.send(clientSocket, "candles", data);
        return;
      }

      // default forward
      clientSocket.emit(event, data);
    } catch (err) {
      console.error(`⚠️ [${short}] erro parse bullex: ${err.message}`);
    }
  });

  bullexWs.on("close", () => {
    console.warn(`🔴 [${short}] Bullex WS closed`);
    if (pingInterval) clearInterval(pingInterval);
    const conn = connections.get(clientSocket.id);
    if (conn) conn.aggregator.clear();
    clientBalances.delete(clientSocket.id);
    clientSocket.emit("disconnected");
    // reconnect with backoff
    if (reconnectAttempts < 6) {
      reconnectAttempts++;
      setTimeout(() => connectToBullEx(ssid, clientSocket), 4000);
    }
  });

  bullexWs.on("error", (err) => {
    console.error(`⚠️ [${short}] Bullex WS error: ${err.message}`);
  });

  // Listen subscribe-active (robusto)
  clientSocket.on("subscribe-active", (rawPayload) => {
    const resolved = resolveActivePayload(rawPayload);
    const shortS = clientSocket.id.slice(0, 8);

    // If resolved null: try to be tolerant and look inside common wrapper keys
    if (!resolved) {
      clientSocket.emit("error", { message: "subscribe-active requires name or active id (accepted: {name}, {active}, string or number)" });
      console.warn(`⚠️ [${shortS}] subscribe-active payload inválido:`, rawPayload);
      return;
    }

    let idToSubscribe = null;
    if (resolved.type === "id") {
      idToSubscribe = resolved.value;
    } else if (resolved.type === "name") {
      const mapped = ACTIVE_MAP[resolved.value];
      if (!mapped) {
        clientSocket.emit("error", { message: `Ativo desconhecido: ${resolved.value}` });
        console.warn(`⚠️ [${shortS}] Ativo textual desconhecido: ${resolved.value}`);
        return;
      }
      idToSubscribe = mapped;
    }

    // send unsubscribe if existed
    const conn = connections.get(clientSocket.id);
    const prior = conn?.currentActive;
    try {
      if (prior && prior !== idToSubscribe) {
        bullexWs.send(JSON.stringify({ name: "unsubscribe-candles", msg: { active_id: prior } }));
        console.log(`🧹 [${shortS}] Unsubscribed ${prior}`);
      }
    } catch (e) {}

    // send subscribe using compat wrapper
    try {
      sendSubscribeCandles(bullexWs, idToSubscribe, "1m");
      if (conn) conn.currentActive = idToSubscribe;
      clientSocket.emit("subscribed-active", [{ name: resolved.type === "name" ? resolved.value : `id-${idToSubscribe}`, id: idToSubscribe }]);
      console.log(`📡 [${shortS}] Subscribed active id ${idToSubscribe}`);
    } catch (e) {
      clientSocket.emit("error", { message: "Falha ao enviar subscribe-candles" });
    }
  });

  // pass-through for order messages
  clientSocket.on("sendMessage", (envelope) => {
    const conn = connections.get(clientSocket.id);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      clientSocket.emit("error", { message: "Bullex WS não conectado" });
      return;
    }
    const payload = envelope?.msg ? envelope.msg : envelope;
    try {
      conn.ws.send(JSON.stringify(payload));
      console.log(`📤 [${clientSocket.id.slice(0,8)}] Reenviando -> ${payload.name || "message"}`);
    } catch (e) {
      clientSocket.emit("error", { message: e.message });
    }
  });

  // keepalive for socket.io
  const heartbeat = setInterval(() => {
    try { if (clientSocket.connected) clientSocket.emit("ping-proxy", { t: Date.now() }); } catch (e) {}
  }, 15000);

  clientSocket.on("disconnect", () => {
    clearInterval(heartbeat);
    if (pingInterval) clearInterval(pingInterval);
    try { bullexWs.close(); } catch (e) {}
    connections.delete(clientSocket.id);
    clientBalances.delete(clientSocket.id);
    console.log(`❌ [${clientSocket.id.slice(0,8)}] Cliente desconectado`);
  });
}

// socket.io server
io.on("connection", (socket) => {
  console.log(`✅ Cliente conectado (Socket.IO): ${socket.id}`);
  socket.on("authenticate", ({ ssid }) => {
    if (!ssid) return socket.emit("error", { message: "SSID não fornecido" });
    // close previous if exists
    const prev = connections.get(socket.id);
    if (prev && prev.ws && prev.ws.readyState === WebSocket.OPEN) {
      try { prev.ws.close(); } catch (e) {}
      prev.aggregator.clear();
      connections.delete(socket.id);
    }
    connectToBullEx(ssid, socket);
  });

  socket.on("get-balance", () => {
    const b = clientBalances.get(socket.id);
    if (b !== undefined) socket.emit("balance", { msg: { current_balance: { amount: b, currency: "USD" } } });
    else socket.emit("balance", { msg: { current_balance: { amount: 0, currency: "USD" } } });
  });
});

app.get("/health", (req, res) => res.json({ status: "ok", connections: connections.size }));
app.get("/", (req, res) => res.json({ message: "Proxy BullEx (robusto) ✅", connections: connections.size }));
