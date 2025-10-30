/**
 * Proxy BullEx - index.js (FINAL)
 * - Name -> ID mapping for assets
 * - subscribe-active (text name) -> subscribe-candles(active_id)
 * - Normalized balances propagation to client
 * - Aggregator + rate limiting for candles
 * - Heartbeat (ping-proxy) to keep socket.io alive
 * - /open endpoint to open binary-options.open-option (uses saved user_balance_id)
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

// socket.io
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

// ----- In-memory stores -----
const connections = new Map(); // socketId -> { ws, aggregator, ssid, user_balance_id, currentActive }
const clientBalances = new Map(); // socketId -> amount (cents or integer representation)

// ----- Asset mapping (text name -> active_id) -----
// Use your full mapping here; this is an example with many OTC and Blitz entries.
// Extend as needed from your "ativos bullex.txt".
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
  // Blitz / digital examples (adjust ids to your actual list)
  "BTCUSD-BLZ": 201,
  "ETHUSD-BLZ": 202,
  "LTCUSD-BLZ": 203,
  "EURUSD-BLZ": 204,
  "GBPUSD-BLZ": 205,
  // ... add the rest from your file
};

// ----- Rate limits & aggregator -----
const RATE_LIMITS = {
  "candles-generated": { interval: 400, maxEvents: 4 },
  "positions-state": { interval: 1000, maxEvents: 6 },
  "balance-changed": { interval: 1000, maxEvents: 6 },
};

class EventAggregator {
  constructor(clientId) {
    this.clientId = clientId;
    this.buffer = {};
    this.timers = {};
    this.trackers = {};
    Object.keys(RATE_LIMITS).forEach((e) => (this.trackers[e] = { count: 0, resetTime: 0 }));
  }

  isWithinLimit(eventName) {
    const cfg = RATE_LIMITS[eventName];
    if (!cfg) return true;
    const now = Date.now();
    const t = this.trackers[eventName];
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
    if (!this.isWithinLimit(eventName)) return false;
    this.buffer[eventName] = data;
    return true;
  }

  send(socket, friendlyEventName, data) {
    if (this.timers[friendlyEventName]) clearTimeout(this.timers[friendlyEventName]);
    this.timers[friendlyEventName] = setTimeout(() => {
      try {
        socket.emit(friendlyEventName, data);
      } catch (e) {}
      delete this.buffer[friendlyEventName];
    }, 100);
  }

  clear() {
    Object.values(this.timers).forEach(clearTimeout);
    this.buffer = {};
    this.timers = {};
  }
}

// ----- Helpers -----
function toCentsMaybe(value) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  // If seems already in cents (very large integer), keep; else convert
  if (n > 100000) return Math.round(n); // already cents-like
  // if decimal (e.g. 98695.57) => cents
  if (!Number.isInteger(n)) return Math.round(n * 100);
  // integer small -> assume dollars -> convert
  return n * 100;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ----- Connect to BullEx per client socket -----
function connectToBullEx(ssid, clientSocket) {
  const shortId = clientSocket.id.slice(0, 8);
  console.log(`📌 [${shortId}] Iniciando autenticação com BullEx...`);

  const bullexWs = new WebSocket("wss://ws.trade.bull-ex.com/echo/websocket", {
    headers: { Origin: "https://trade.bull-ex.com", "User-Agent": "Mozilla/5.0" },
  });

  const aggregator = new EventAggregator(clientSocket.id);
  let pingInterval = null;
  let subscribedActiveId = null;
  let reconnectAttempts = 0;

  // Store connection object
  connections.set(clientSocket.id, { ws: bullexWs, aggregator, ssid, user_balance_id: null, currentActive: null });

  bullexWs.on("open", () => {
    console.log(`✅ [${shortId}] Conectado à BullEx. Enviando authenticate...`);
    reconnectAttempts = 0;
    bullexWs.send(JSON.stringify({ name: "authenticate", msg: { ssid, protocol: 3, client_session_id: "" } }));

    // Keep-alive ping to BullEx
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

      // Minimal logging (avoid spamming)
      if (!["ping", "pong", "timeSync"].includes(event)) {
        console.log(`📨 [${shortId}] Evento: ${event}`);
      }

      // respond to ping from BullEx
      if (event === "ping") {
        bullexWs.send(JSON.stringify({ name: "pong" }));
        return;
      }
      if (event === "timeSync") {
        // don't forward timeSync flood to client; you may log or ignore
        return;
      }

      // AUTH
      if (event === "authenticated") {
        clientSocket.emit("authenticated", data);
        // Failsafe: ask for balances and subscribe to positions
        setTimeout(() => {
          try {
            // Some endpoints expect wrapped "sendMessage" but BullEx accepts both in practice.
            bullexWs.send(JSON.stringify({ name: "sendMessage", msg: { name: "balances.get-balances", version: "1.0", body: {} } }));
            bullexWs.send(JSON.stringify({ name: "sendMessage", msg: { name: "subscribe-positions", version: "1.0", body: {} } }));
            console.log(`💵 [${shortId}] Pedido de saldo/subscribe-positions enviado`);
          } catch (e) {}
        }, 700);
        return;
      }

      // unauthorized
      if (event === "unauthorized") {
        clientSocket.emit("unauthorized", data);
        return;
      }

      // balances (array) or balance-changed
      if (event === "balances" || event === "balance-changed") {
        // normalize and extract a single balance and id if possible
        let amountCents = null;
        let currency = "USD";
        let user_balance_id = null;

        if (event === "balance-changed") {
          const cur = data?.msg?.current_balance;
          if (cur) {
            amountCents = toCentsMaybe(cur.amount);
            currency = cur.currency || currency;
            user_balance_id = cur.id || cur.user_balance_id || null;
          }
        } else if (event === "balances") {
          // some payloads: data.msg is array
          const arr = data.msg;
          if (Array.isArray(arr) && arr.length) {
            // prefer USD entry
            let pick = arr.find((b) => b.currency === "USD") || arr[0];
            amountCents = toCentsMaybe(pick.amount);
            currency = pick.currency || currency;
            user_balance_id = pick.id || pick.user_balance_id || null;
          }
        }

        if (amountCents != null) {
          console.log(`💰 [${shortId}] Saldo detectado: ${currency} $${(amountCents/100).toFixed(2)}`);
          clientBalances.set(clientSocket.id, amountCents);

          // save into connection entry for /open usage
          const conn = connections.get(clientSocket.id);
          if (conn) conn.user_balance_id = user_balance_id || conn.user_balance_id;

          // Emit standardized events to client
          clientSocket.emit("balance", { msg: { current_balance: { id: user_balance_id, amount: amountCents, currency } } });
          clientSocket.emit("balance-changed", { name: "balance-changed", msg: { current_balance: { id: user_balance_id, amount: amountCents, currency } } });
          clientSocket.emit("current-balance", { msg: { current_balance: { id: user_balance_id, amount: amountCents, currency, timestamp: Date.now() } } });
        }
        return;
      }

      // position-changed
      if (event === "position-changed") {
        clientSocket.emit("position-changed", data);
        return;
      }

      // candles (high frequency)
      if (event === "candles-generated" || event === "candle-generated") {
        if (aggregator.aggregate("candles-generated", data)) {
          aggregator.send(clientSocket, "candles", data);
        }
        return;
      }

      // other events -> forward
      clientSocket.emit(event, data);
    } catch (err) {
      console.error(`⚠️ [${shortId}] Erro parse Bullex message: ${err.message}`);
    }
  });

  bullexWs.on("close", () => {
    console.warn(`🔴 [${shortId}] Conexão Bullex encerrada`);
    if (pingInterval) clearInterval(pingInterval);
    const conn = connections.get(clientSocket.id);
    if (conn) conn.aggregator.clear();
    clientBalances.delete(clientSocket.id);
    clientSocket.emit("disconnected");

    // reconnect attempts with backoff
    if (reconnectAttempts < 6) {
      reconnectAttempts++;
      console.log(`🔁 [${shortId}] Tentativa de reconexão #${reconnectAttempts} em 4s`);
      setTimeout(() => {
        // re-run connectToBullEx using same ssid (will replace connection entry)
        try { connectToBullEx(ssid, clientSocket); } catch (e) {}
      }, 4000);
    }
  });

  bullexWs.on("error", (err) => {
    console.error(`⚠️ [${shortId}] Bullex WS error: ${err.message}`);
    clientSocket.emit("error", { message: err.message });
  });

  // ----- clientSocket listeners: subscribe-active (name) -----
  // The Lovable app sends: socket.emit("subscribe-active", { name: "EURUSD-OTC" })
  clientSocket.on("subscribe-active", ({ name, timeframe = "1m" } = {}) => {
    const short = clientSocket.id.slice(0, 8);
    if (!name) {
      clientSocket.emit("error", { message: "subscribe-active requires name" });
      return;
    }
    const id = ACTIVE_MAP[name];
    if (!id) {
      clientSocket.emit("error", { message: `Ativo desconhecido: ${name}` });
      console.warn(`⚠️ [${short}] Ativo desconhecido solicitado: ${name}`);
      return;
    }

    // Unsubscribe previous active if exists
    const conn = connections.get(clientSocket.id);
    const priorId = conn?.currentActive;
    if (priorId && priorId !== id) {
      try {
        bullexWs.send(JSON.stringify({ name: "unsubscribe-candles", msg: { active_id: priorId } }));
        console.log(`🧹 [${short}] Unsubscribed candles for active ${priorId}`);
      } catch (e) {}
    }

    // Subscribe new active by ID
    const size = 1; // M1 candles
    // Build msg as expected by BullEx (version/body or msg - both patterns seen; choose 'msg' wrapper to be safe)
    const subMsg = { name: "subscribe-candles", version: "1.0", body: { active_id: id, size, at: timeframe } };
    try {
      bullexWs.send(JSON.stringify(subMsg));
      conn.currentActive = id;
      console.log(`📡 [${short}] Subscribed candles for ${name} (id ${id})`);
      // reply to client that subscription succeeded
      clientSocket.emit("subscribed-active", [{ name, id }]);
    } catch (e) {
      clientSocket.emit("error", { message: "Falha ao enviar subscribe-candles" });
    }
  });

  // ----- proxy pass-through for generic sendMessage from client (orders etc) -----
  clientSocket.on("sendMessage", (envelope) => {
    const conn = connections.get(clientSocket.id);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      clientSocket.emit("error", { message: "Bullex WebSocket não conectado" });
      return;
    }
    const payload = envelope.msg ? envelope.msg : envelope;
    try {
      conn.ws.send(JSON.stringify(payload));
      console.log(`📤 [${clientSocket.id.slice(0,8)}] Reenviando -> ${payload.name || 'message'}`);
    } catch (e) {
      clientSocket.emit("error", { message: e.message });
    }
  });

  // heartbeat to client (keep socket.io connection active)
  const heartbeat = setInterval(() => {
    try {
      if (clientSocket.connected) clientSocket.emit("ping-proxy", { t: Date.now() });
    } catch (e) {}
  }, 15000);

  clientSocket.on("disconnect", () => {
    clearInterval(heartbeat);
    if (pingInterval) clearInterval(pingInterval);
    try { bullexWs.close(); } catch (e) {}
    connections.delete(clientSocket.id);
    clientBalances.delete(clientSocket.id);
    console.log(`❌ [${clientSocket.id.slice(0,8)}] Cliente desconectado (socket.io)`);
  });
}

// ----- socket.io server -----
io.on("connection", (clientSocket) => {
  console.log(`✅ Cliente conectado (Socket.IO): ${clientSocket.id}`);
  clientSocket.on("authenticate", ({ ssid }) => {
    if (!ssid) {
      clientSocket.emit("error", { message: "SSID não fornecido" });
      return;
    }
    // If there was an existing connection for this socket id, close it
    const prev = connections.get(clientSocket.id);
    if (prev && prev.ws && prev.ws.readyState === WebSocket.OPEN) {
      try { prev.ws.close(); } catch (e) {}
      prev.aggregator.clear();
      connections.delete(clientSocket.id);
    }
    connectToBullEx(ssid, clientSocket);
  });

  // get cached balance quickly
  clientSocket.on("get-balance", () => {
    const b = clientBalances.get(clientSocket.id);
    if (b !== undefined) {
      clientSocket.emit("balance", { msg: { current_balance: { amount: b, currency: "USD" } } });
    } else {
      clientSocket.emit("balance", { msg: { current_balance: { amount: 0, currency: "USD" } } });
    }
  });

  clientSocket.on("disconnect", () => {
    // handled in connectToBullEx disconnect handler
  });
});

// ----- HTTP endpoint to open an order (optional, useful for server-side requests) -----
app.post("/open", (req, res) => {
  try {
    const { socketId, ssid, direction, stake, activeId, timeframe = "M1", customSeconds = 5 } = req.body;
    let connEntry = null;
    if (socketId) connEntry = connections.get(socketId);
    else if (ssid) connEntry = Array.from(connections.values()).find((c) => c.ssid === ssid);

    if (!connEntry || !connEntry.ws || connEntry.ws.readyState !== WebSocket.OPEN) {
      return res.status(400).json({ ok: false, error: "Conexão Bullex não encontrada/aberta" });
    }

    const user_balance_id = connEntry.user_balance_id;
    if (!user_balance_id) return res.status(400).json({ ok: false, error: "user_balance_id ausente (aguarde balances)" });

    const now = nowSeconds();
    let option_type_id = 3; // M1
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

    connEntry.ws.send(JSON.stringify({ name: "sendMessage", msg: payload }));
    console.log(`🎯 [proxy] Ordem enviada: ${direction} active:${payload.body.active_id} $${stake}`);
    return res.json({ ok: true, sent: payload });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Health
app.get("/health", (req, res) => res.json({ status: "ok", connections: connections.size, timestamp: new Date().toISOString() }));
app.get("/", (req, res) => res.json({ message: "Proxy BullEx Ativo ✅", connections: connections.size }));

