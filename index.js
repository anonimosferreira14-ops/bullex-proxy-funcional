/**
 * Proxy BullEx - index.js (FINAL - compatível com seu hook)
 * - Ativo inicial: EURUSD-OTC
 * - Aceita { active: "EURUSD-OTC" } | { name: "EURUSD-OTC" } | "EURUSD-OTC" | 76
 * - Emite: balance, balance-changed, current-balance, candles, position-changed, positions-state, subscription, client-buyback-generated
 * - Não repassa timeSync ao front
 */

import express from "express";
import { Server } from "socket.io";
import cors from "cors";
import WebSocket from "ws";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy BullEx ativo em 0.0.0.0:${PORT}`);
});

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

/* ===========================
   Asset mapping (text -> id)
   Complete / extend with your ativos bullex.txt
   =========================== */
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
  "GBPCHF-OTC": 86,
  "AUDJPY-OTC": 87,
  "AUDCAD-OTC": 88,
  "NZDUSD-OTC": 89,
  // Blitz examples
  "BTCUSD-BLZ": 201,
  "ETHUSD-BLZ": 202,
  "LTCUSD-BLZ": 203,
  "EURUSD-BLZ": 204,
  "GBPUSD-BLZ": 205,
  "USDJPY-BLZ": 206,
  "AUDUSD-BLZ": 207,
  "EURJPY-BLZ": 208,
  "USDCAD-BLZ": 209,
  "USDCHF-BLZ": 210,
};

/* In-memory stores */
const connections = new Map(); // socketId -> { ws, aggregator, ssid, user_balance_id, currentActive }
const clientBalances = new Map(); // socketId -> amount (cents)

/* Small aggregator to avoid candle spam */
class SimpleAggregator {
  constructor() { this.timers = {}; }
  send(socket, event, data, delay = 100) {
    if (this.timers[event]) clearTimeout(this.timers[event]);
    this.timers[event] = setTimeout(() => {
      try { socket.emit(event, data); } catch (e) {}
    }, delay);
  }
  clear() { Object.values(this.timers).forEach(clearTimeout); }
}

/* Helpers */
function toCentsMaybe(val) {
  if (val == null) return null;
  const n = Number(val);
  if (Number.isNaN(n)) return null;
  if (!Number.isInteger(n)) return Math.round(n * 100);
  // integer: heuristic - if small treat as dollars -> cents
  if (n < 100000) return n * 100;
  return n;
}

/* Resolve payloads for subscribe-active: accepts many shapes */
function resolveActivePayload(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") return { type: "name", value: raw };
  if (typeof raw === "number") return { type: "id", value: raw };
  if (typeof raw === "object") {
    // common variants
    if (raw.active && (typeof raw.active === "string" || typeof raw.active === "number")) {
      return typeof raw.active === "number" ? { type: "id", value: raw.active } : { type: "name", value: raw.active };
    }
    if (raw.name && (typeof raw.name === "string" || typeof raw.name === "number")) {
      return typeof raw.name === "number" ? { type: "id", value: raw.name } : { type: "name", value: raw.name };
    }
    if (raw.msg && raw.msg.name && typeof raw.msg.name === "string") return { type: "name", value: raw.msg.name };
    if (raw.payload && typeof raw.payload === "string") return { type: "name", value: raw.payload };
  }
  return null;
}

/* Send subscribe-candles with compatibility wrappers */
function sendSubscribeCandles(bullexWs, id, timeframe = "1m") {
  try {
    // wrapper sendMessage
    const wrapper = {
      name: "sendMessage",
      msg: {
        name: "subscribe-candles",
        version: "1.0",
        body: { active_id: id, size: 1, at: timeframe },
      },
    };
    bullexWs.send(JSON.stringify(wrapper));
    // also send direct variant (some servers expect this)
    bullexWs.send(JSON.stringify({ name: "subscribe-candles", version: "1.0", body: { active_id: id, size: 1, at: timeframe } }));
  } catch (e) { /* ignore */ }
}

/* Core: connect per client socket */
function connectToBullEx(ssid, clientSocket) {
  const short = clientSocket.id.slice(0, 8);
  console.log(`📌 [${short}] Iniciando autenticação com BullEx...`);

  const bullexWs = new WebSocket("wss://ws.trade.bull-ex.com/echo/websocket", {
    headers: { Origin: "https://trade.bull-ex.com", "User-Agent": "Mozilla/5.0" },
  });

  const aggregator = new SimpleAggregator();
  let pingInterval = null;
  let reconnectAttempts = 0;

  // store connection object
  connections.set(clientSocket.id, { ws: bullexWs, aggregator, ssid, user_balance_id: null, currentActive: null });

  bullexWs.on("open", () => {
    console.log(`✅ [${short}] Conectado à BullEx. Autenticando...`);
    reconnectAttempts = 0;
    bullexWs.send(JSON.stringify({ name: "authenticate", msg: { ssid, protocol: 3, client_session_id: "" } }));

    // ping keepalive to BullEx
    pingInterval = setInterval(() => {
      if (bullexWs.readyState === WebSocket.OPEN) try { bullexWs.send(JSON.stringify({ name: "ping" })); } catch (e) {}
    }, 20000);
  });

  bullexWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const event = data.name || data.event || "unknown";

      if (!["ping", "pong", "timeSync"].includes(event)) console.log(`📨 [${short}] Evento: ${event}`);

      // respond ping
      if (event === "ping") { bullexWs.send(JSON.stringify({ name: "pong" })); return; }
      // ignore timeSync flooding to front (we don't forward)
      if (event === "timeSync") return;

      // AUTH
      if (event === "authenticated") {
        clientSocket.emit("authenticated", data);

        // After auth, request balances, positions, actives list and subscribe default EURUSD-OTC
        setTimeout(() => {
          try {
            bullexWs.send(JSON.stringify({ name: "sendMessage", msg: { name: "balances.get-balances", version: "1.0", body: {} } }));
            bullexWs.send(JSON.stringify({ name: "sendMessage", msg: { name: "subscribe-positions", version: "1.0", body: {} } }));
            bullexWs.send(JSON.stringify({ name: "sendMessage", msg: { name: "actives.get-all", version: "1.0", body: {} } }));
            // default subscribe EURUSD-OTC -> id 76 (as requested)
            const defaultId = ACTIVE_MAP["EURUSD-OTC"];
            if (defaultId) sendSubscribeCandles(bullexWs, defaultId, "1m");
            console.log(`💵 [${short}] Pedido de saldo, positions, actives e candles(EURUSD-OTC) enviados`);
          } catch (e) {}
        }, 700);
        return;
      }

      if (event === "unauthorized") {
        clientSocket.emit("unauthorized", data);
        return;
      }

      // balances array or balance-changed
      if (event === "balances" || event === "balance-changed") {
        let amount = null, currency = "USD", ubid = null;
        if (event === "balance-changed") {
          const cur = data?.msg?.current_balance;
          if (cur) { amount = cur.amount; currency = cur.currency || currency; ubid = cur.id || cur.user_balance_id || null; }
        } else if (event === "balances") {
          const arr = data.msg;
          if (Array.isArray(arr) && arr.length) {
            const usd = arr.find(b => b.currency === "USD") || arr[0];
            if (usd) { amount = usd.amount; currency = usd.currency || currency; ubid = usd.id || usd.user_balance_id || null; }
          }
        }
        if (amount != null) {
          clientBalances.set(clientSocket.id, amount);
          const conn = connections.get(clientSocket.id);
          if (conn) conn.user_balance_id = ubid || conn.user_balance_id;
          // emit normalized events (your hook expects 'balance' as shown)
          clientSocket.emit("balance", { msg: { current_balance: { id: ubid, amount, currency } } });
          clientSocket.emit("balance-changed", { name: "balance-changed", msg: { current_balance: { id: ubid, amount, currency } } });
          clientSocket.emit("current-balance", { msg: { current_balance: { id: ubid, amount, currency, timestamp: Date.now() } } });
          console.log(`💰 [${short}] Saldo detectado: ${currency} $${(amount/100).toFixed(2)}`);
        }
        return;
      }

      // subscription info (forward)
      if (event === "subscription") {
        clientSocket.emit("subscription", data);
        return;
      }

      // pressure / buyback event -> forward as both names (compat)
      if (event === "price-splitter.client-buyback-generated" || event === "client-buyback-generated") {
        clientSocket.emit("price-splitter.client-buyback-generated", data);
        clientSocket.emit("client-buyback-generated", data); // your hook looks for client-buyback-generated
        return;
      }

      // positions-state / position-changed
      if (event === "positions-state") {
        clientSocket.emit("positions-state", data);
        return;
      }
      if (event === "position-changed") {
        clientSocket.emit("position-changed", data);
        return;
      }

      // candles high-frequency -> aggregate and forward as "candles"
      if (event === "candles-generated" || event === "candle-generated") {
        aggregator.send(clientSocket, "candles", data, 80);
        return;
      }

      // default forward
      clientSocket.emit(event, data);
    } catch (err) {
      console.error(`⚠️ [${short}] Erro parse Bullex message: ${err.message}`);
    }
  });

  bullexWs.on("close", () => {
    console.warn(`🔴 [${short}] Conexão Bullex encerrada`);
    if (pingInterval) clearInterval(pingInterval);
    const conn = connections.get(clientSocket.id);
    if (conn) conn.aggregator.clear();
    clientBalances.delete(clientSocket.id);
    clientSocket.emit("disconnected");
    // reconnect attempts
    if (reconnectAttempts < 6) {
      reconnectAttempts++;
      console.log(`🔁 [${short}] Reconectando em 4s (#${reconnectAttempts})`);
      setTimeout(() => { try { connectToBullEx(ssid, clientSocket); } catch (e) {} }, 4000);
    }
  });

  bullexWs.on("error", (err) => {
    console.error(`⚠️ [${short}] Bullex WS error: ${err.message}`);
    clientSocket.emit("error", { message: err.message });
  });

  /* ========== Client socket handlers ========== */

  // subscribe-active: robust resolver (accepts many shapes)
  clientSocket.on("subscribe-active", (rawPayload) => {
    const resolved = resolveActivePayload(rawPayload);
    const shortS = clientSocket.id.slice(0, 8);
    if (!resolved) {
      clientSocket.emit("error", { message: "subscribe-active requires name or active id (accepted: { active: 'EURUSD-OTC' }, { name: 'EURUSD-OTC' }, string, number)" });
      console.warn(`⚠️ [${shortS}] subscribe-active payload inválido:`, rawPayload);
      return;
    }

    let idToSubscribe = null;
    let textualName = null;
    if (resolved.type === "id") {
      idToSubscribe = resolved.value;
    } else {
      textualName = resolved.value;
      const mapped = ACTIVE_MAP[textualName];
      if (!mapped) {
        clientSocket.emit("error", { message: `Ativo desconhecido: ${textualName}` });
        console.warn(`⚠️ [${shortS}] Ativo textual desconhecido: ${textualName}`);
        return;
      }
      idToSubscribe = mapped;
    }

    const conn = connections.get(clientSocket.id);
    const prior = conn?.currentActive;
    try {
      if (prior && prior !== idToSubscribe) {
        bullexWs.send(JSON.stringify({ name: "unsubscribe-candles", msg: { active_id: prior } }));
        console.log(`🧹 [${shortS}] Unsubscribed active ${prior}`);
      }
    } catch (e) {}

    try {
      sendSubscribeCandles(bullexWs, idToSubscribe, "1m");
      if (conn) conn.currentActive = idToSubscribe;
      clientSocket.emit("subscribed-active", [{ name: textualName || `id-${idToSubscribe}`, id: idToSubscribe }]);
      console.log(`📡 [${shortS}] Subscribed active id ${idToSubscribe}`);
    } catch (e) {
      clientSocket.emit("error", { message: "Falha ao enviar subscribe-candles" });
    }
  });

  // generic pass-through for orders or other sendMessage calls
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

  // heartbeat to client to prevent transport close
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

/* ========== Socket.IO server ========== */
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

/* Health endpoints */
app.get("/health", (req, res) => res.json({ status: "ok", connections: connections.size }));
app.get("/", (req, res) => res.json({ message: "Proxy BullEx final rodando ✅", connections: connections.size }));
