/**
 * Proxy BullEx - index.js
 * - Dynamic active subscribe by name (subscribe-active)
 * - Full assets mapping (OTC + BLZ) from ativos bullex.txt
 * - Robust balances handling (balances array + balance-changed)
 * - /open endpoint to open orders via proxy
 * - Aggregator + rate limiting for candles
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

const connections = new Map(); // socketId -> { ws, aggregator, ssid, user_balance_id, currentActive }
const clientBalances = new Map(); // socketId -> balance (in cents)

// ------------------- Helpers -------------------
function toCents(amount) {
  if (amount == null) return null;
  const num = typeof amount === "string" ? Number(amount) : amount;
  if (Number.isNaN(num)) return null;
  if (!Number.isInteger(num)) return Math.round(num * 100);
  // integer: heuristic - if large assume cents
  if (num > 100000) return num;
  return num * 100;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ------------------- Asset mapping (all assets from seu arquivo) -------------------
const ACTIVE_NAME_TO_ID = {
  // OTC (binários)
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
  "AUDJPY-OTC": 86,
  "NZDUSD-OTC": 87,
  "EURAUD-OTC": 88,
  "GBPCHF-OTC": 89,
  // BLZ (blitz)
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

// ------------------- Rate limits & Aggregator -------------------
const RATE_LIMITS = {
  "candle-generated": { interval: 500, maxEvents: 5 },
  "candles-generated": { interval: 500, maxEvents: 5 },
  "price-splitter.client-buyback-generated": { interval: 1000, maxEvents: 3 },
  "positions-state": { interval: 1000, maxEvents: 10 },
  "balance-changed": { interval: 500, maxEvents: 10 },
};

class EventAggregator {
  constructor(clientId) {
    this.clientId = clientId;
    this.buffer = {};
    this.timers = {};
    this.rateLimitTrackers = {};
    Object.keys(RATE_LIMITS).forEach((e) => {
      this.rateLimitTrackers[e] = { count: 0, resetTime: 0 };
    });
  }

  isWithinRateLimit(eventName) {
    const cfg = RATE_LIMITS[eventName];
    if (!cfg) return true;
    const now = Date.now();
    const t = this.rateLimitTrackers[eventName];
    if (now > t.resetTime) {
      t.count = 0;
      t.resetTime = now + cfg.interval;
    }
    if (t.count < cfg.maxEvents) {
      t.count++;
      return true;
    }
    return false;
  }

  aggregate(eventName, data) {
    if (!this.isWithinRateLimit(eventName)) return false;
    this.buffer[eventName] = data;
    return true;
  }

  // emits both friendlyName and originalEventName for compatibility
  sendAggregated(socket, friendlyName, data, originalEventName) {
    if (this.timers[friendlyName]) clearTimeout(this.timers[friendlyName]);
    this.timers[friendlyName] = setTimeout(() => {
      try {
        socket.emit(friendlyName, data);
        if (originalEventName && originalEventName !== friendlyName) socket.emit(originalEventName, data);
      } catch (e) {
        // ignore
      } finally {
        delete this.buffer[friendlyName];
      }
    }, 100);
  }

  clear() {
    Object.values(this.timers).forEach(clearTimeout);
    this.buffer = {};
    this.timers = {};
  }
}

// ------------------- Connect to BullEx -------------------
function connectToBullEx(ssid, clientSocket) {
  const shortId = clientSocket.id.substring(0, 8);
  console.log(`📌 [${shortId}] Iniciando autenticação com BullEx...`);

  const bullexWs = new WebSocket("wss://ws.trade.bull-ex.com/echo/websocket", {
    headers: { Origin: "https://trade.bull-ex.com", "User-Agent": "Mozilla/5.0" },
  });

  const aggregator = new EventAggregator(clientSocket.id);
  let pingInterval = null;

  bullexWs.on("open", () => {
    console.log(`✅ [${shortId}] Conectado à BullEx. Enviando autenticação...`);
    const auth = { name: "authenticate", msg: { ssid, protocol: 3, client_session_id: "" } };
    bullexWs.send(JSON.stringify(auth));

    // ping keepalive
    pingInterval = setInterval(() => {
      if (bullexWs.readyState === WebSocket.OPEN) bullexWs.send(JSON.stringify({ name: "ping" }));
    }, 20000);
  });

  bullexWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const event = data.name || "unknown";
      if (event !== "ping" && event !== "pong" && event !== "timeSync") {
        console.log(`📨 [${shortId}] Evento: ${event}`);
      }

      // AUTH
      if (event === "authenticated") {
        clientSocket.emit("authenticated", data);

        // Failsafe: subscribe balances & request balances
        setTimeout(() => {
          try {
            bullexWs.send(JSON.stringify({ name: "subscribe-balances", version: "1.0", body: {} }));
            bullexWs.send(JSON.stringify({ name: "sendMessage", msg: { name: "balances.get-balances", version: "1.0", body: {} } }));
            console.log(`💵 [${shortId}] Pedido de saldo enviado / subscribed balances`);
          } catch (e) {}
        }, 600);

        return;
      }

      if (event === "unauthorized") {
        clientSocket.emit("unauthorized", data);
        return;
      }

      // ping/pong
      if (event === "ping") {
        bullexWs.send(JSON.stringify({ name: "pong" }));
        return;
      }
      if (event === "pong" || event === "timeSync") return;

      // front handshake
      if (event === "front") {
        clientSocket.emit("front", data);
        return;
      }

      // balances (array) or balance-changed
      if (event === "balances" || event === "balance-changed") {
        // normalize both shapes
        let balanceCents = null;
        let currency = "USD";
        let balanceId = null;

        if (event === "balance-changed") {
          const b = data?.msg?.current_balance;
          if (b) {
            balanceCents = toCents(b.amount);
            currency = b.currency || "USD";
            balanceId = b.id;
          }
        } else if (event === "balances" && Array.isArray(data?.msg)) {
          // data.msg is an array of balances
          const usd = data.msg.find((x) => x.currency === "USD") || data.msg[0];
          if (usd) {
            // some arrays have amount as decimals (e.g. 98695.57) -> convert to cents
            balanceCents = toCents(usd.amount);
            currency = usd.currency || "USD";
            balanceId = usd.id;
          }
        }

        if (balanceCents != null) {
          console.log(`💰 [${shortId}] Saldo detectado: ${currency} $${(balanceCents / 100).toFixed(2)}`);
          clientBalances.set(clientSocket.id, balanceCents);

          // Save user_balance_id on connections entry for /open
          const conn = connections.get(clientSocket.id);
          if (conn) conn.user_balance_id = balanceId || conn.user_balance_id;

          // emit standardized payloads for front compatibility
          clientSocket.emit("balance", {
            msg: { current_balance: { id: balanceId, amount: balanceCents, currency } },
          });
          clientSocket.emit("balance-changed", {
            name: "balance-changed",
            msg: { current_balance: { id: balanceId, amount: balanceCents, currency } },
          });
          clientSocket.emit("current-balance", {
            msg: { current_balance: { id: balanceId, amount: balanceCents, currency, timestamp: Date.now() } },
          });
        }

        return;
      }

      // position changed
      if (event === "position-changed") {
        clientSocket.emit("position-changed", data);
        return;
      }

      // candles high-frequency
      if (event === "candles-generated" || event === "candle-generated") {
        if (aggregator.aggregate("candle-generated", data)) {
          aggregator.sendAggregated(clientSocket, "candles", data, event);
        }
        return;
      }

      // other aggregated
      if (event === "price-splitter.client-buyback-generated") {
        if (aggregator.aggregate(event, data)) {
          aggregator.sendAggregated(clientSocket, "pressure", data, event);
        }
        return;
      }

      if (event === "positions-state") {
        if (aggregator.aggregate(event, data)) {
          aggregator.sendAggregated(clientSocket, "positions", data, event);
        }
        return;
      }

      // default re-emit everything else
      clientSocket.emit(event, data);
    } catch (err) {
      console.error(`⚠️ Error parsing message from Bullex [${shortId}]: ${err.message}`);
    }
  });

  bullexWs.on("close", () => {
    console.warn(`🔴 [${shortId}] Conexão Bullex encerrada`);
    if (connections.has(clientSocket.id)) {
      const c = connections.get(clientSocket.id);
      if (c) c.aggregator.clear();
    }
    clientBalances.delete(clientSocket.id);
    clientSocket.emit("disconnected");
  });

  bullexWs.on("error", (err) => {
    console.error(`⚠️ [${shortId}] Bullex WebSocket error: ${err.message}`);
    clientSocket.emit("error", { message: err.message });
  });

  // register connection entry
  connections.set(clientSocket.id, { ws: bullexWs, aggregator, ssid, user_balance_id: null, currentActive: null });
}

// ------------------- SOCKET.IO Handlers -------------------
io.on("connection", (clientSocket) => {
  const shortId = clientSocket.id.substring(0, 8);
  console.log(`✅ Cliente conectado: ${shortId}`);

  // authenticate -> connect to bullEx
  clientSocket.on("authenticate", ({ ssid }) => {
    if (!ssid) return clientSocket.emit("error", { message: "SSID não fornecido" });
    // avoid double-connect: if existing conn, close it first
    const existing = connections.get(clientSocket.id);
    if (existing && existing.ws && existing.ws.readyState === WebSocket.OPEN) {
      try { existing.ws.close(); } catch (e) {}
      existing.aggregator.clear();
      connections.delete(clientSocket.id);
    }
    connectToBullEx(ssid, clientSocket);
  });

  // generic sendMessage proxy (normalize)
  clientSocket.on("sendMessage", (envelope) => {
    const conn = connections.get(clientSocket.id);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      clientSocket.emit("error", { message: "WebSocket Bullex não conectado" });
      return;
    }
    // envelope may be { name: 'sendMessage', msg: { ... } } or already msg
    const payload = envelope.msg ? envelope.msg : envelope;
    try {
      conn.ws.send(JSON.stringify(payload));
      console.log(`📤 [${shortId}] Reenviando -> ${payload.name || payload.msg?.name || "message"}`);
    } catch (e) {
      clientSocket.emit("error", { message: e.message });
    }
  });

  // subscribe-active by name (app sends the name, proxy maps to id)
  clientSocket.on("subscribe-active", ({ name, timeframe = "1m" } = {}) => {
    const conn = connections.get(clientSocket.id);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      clientSocket.emit("error", { message: "Conexão Bullex não disponível para subscribe-active" });
      return;
    }
    if (!name) return clientSocket.emit("error", { message: "subscribe-active requer name" });
    const id = ACTIVE_NAME_TO_ID[name];
    if (!id) return clientSocket.emit("error", { message: `Ativo desconhecido: ${name}` });

    // unsubscribe prior
    const prior = conn.currentActive;
    if (prior && prior !== id) {
      try {
        conn.ws.send(JSON.stringify({ name: "unsubscribe-candles", version: "1.0", body: { active_id: prior } }));
        console.log(`🧹 [${shortId}] Unsubscribed candles for active ${prior}`);
      } catch (e) {}
    }

    // subscribe new
    const size = 1;
    const at = timeframe === "1m" ? "1m" : timeframe; // keep flexible
    const subMsg = { name: "subscribe-candles", version: "1.0", body: { active_id: id, size, at } };
    try {
      conn.ws.send(JSON.stringify(subMsg));
      conn.currentActive = id;
      console.log(`📡 [${shortId}] Subscribed candles for ${name} (id ${id})`);
      clientSocket.emit("subscribed-active", { name, id });
    } catch (e) {
      clientSocket.emit("error", { message: "Falha ao enviar subscribe-candles" });
    }
  });

  // request balance cached
  clientSocket.on("get-balance", () => {
    const bal = clientBalances.get(clientSocket.id);
    if (bal !== undefined) {
      clientSocket.emit("balance", { msg: { current_balance: { amount: bal, currency: "USD" } } });
    } else {
      clientSocket.emit("balance", { msg: { current_balance: { amount: 0, currency: "USD" } } });
    }
  });

  clientSocket.on("disconnect", () => {
    const conn = connections.get(clientSocket.id);
    if (conn) {
      try { conn.ws.close(); } catch (e) {}
      conn.aggregator.clear();
      connections.delete(clientSocket.id);
    }
    clientBalances.delete(clientSocket.id);
    console.log(`❌ [${shortId}] Desconectado`);
  });
});

// ------------------- HTTP endpoint to open orders -------------------
app.post("/open", (req, res) => {
  /**
   * body:
   * {
   *   socketId: "<socket id>"   // or ssid
   *   direction: "call"|"put",
   *   stake: 1.5, // dollars
   *   activeId: 76, // optional if you want direct id
   *   timeframe: "M1"|"M5"|"custom",
   *   customSeconds: 5
   * }
   */
  try {
    const { socketId, ssid, direction, stake, activeId, timeframe = "M1", customSeconds = 5 } = req.body;
    let connEntry = null;

    if (socketId) connEntry = connections.get(socketId);
    else if (ssid) connEntry = Array.from(connections.values()).find((c) => c.ssid === ssid);

    if (!connEntry || !connEntry.ws || connEntry.ws.readyState !== WebSocket.OPEN) {
      return res.status(400).json({ ok: false, error: "Conexão Bullex não encontrada/aberta" });
    }

    // choose user_balance_id saved from balances
    const user_balance_id = connEntry.user_balance_id;
    if (!user_balance_id) return res.status(400).json({ ok: false, error: "user_balance_id ausente no proxy (aguarde balances)" });

    const now = nowSeconds();
    let option_type_id = 3; // default M1
    let expired = now + customSeconds;
    if (timeframe === "M1") { option_type_id = 3; expired = Math.ceil(now / 60) * 60; }
    else if (timeframe === "M5") { option_type_id = 12; expired = Math.ceil(now / 300) * 300; }
    else if (timeframe === "M15") { option_type_id = 13; expired = Math.ceil(now / 900) * 900; }
    else if (timeframe === "custom") { option_type_id = 3; expired = now + customSeconds; }

    const payload = {
      name: "binary-options.open-option",
      version: "2.0",
      body: {
        user_balance_id,
        active_id: activeId || connEntry.currentActive || null,
        option_type_id,
        direction,
        expired,
        price: Math.round(stake * 100),
        value: Math.round(stake * 100),
        profit_percent: 88,
        refund_value: 0,
      },
    };

    if (!payload.body.active_id) return res.status(400).json({ ok: false, error: "active_id ausente (especifique activeId ou subscribe-active antes)" });

    connEntry.ws.send(JSON.stringify(payload));
    console.log(`🎯 [proxy] Ordem enviada: ${direction} active:${payload.body.active_id} $${stake}`);
    return res.json({ ok: true, sent: payload });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ------------------- Health -------------------
app.get("/health", (req, res) =>
  res.json({ status: "ok", connections: connections.size, timestamp: new Date().toISOString() })
);

app.get("/status", (req, res) =>
  res.json({
    uptime: process.uptime(),
    connections: connections.size,
    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
  })
);
