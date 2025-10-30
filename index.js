// ===============================
// PROXY BULL-EX INTELIGENTE (V3)
// Foco: Ativo Único + Candles Otimizados
// ===============================

import express from "express";
import { Server } from "socket.io";
import cors from "cors";
import WebSocket from "ws";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Proxy BullEx ativo em 0.0.0.0:${PORT}`)
);

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

const connections = new Map();
const clientBalances = new Map();

// ===============================
// RATE LIMIT CONFIG
// ===============================
const RATE_LIMITS = {
  "candles-generated": { interval: 500, maxEvents: 3 },
  "positions-state": { interval: 1000, maxEvents: 8 },
  "balance-changed": { interval: 800, maxEvents: 6 },
};

// ===============================
// EVENT AGGREGATOR
// ===============================
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
  isWithinRateLimit(event) {
    const config = RATE_LIMITS[event];
    if (!config) return true;
    const now = Date.now();
    const tracker = this.rateLimitTrackers[event];
    if (now > tracker.resetTime) {
      tracker.count = 0;
      tracker.resetTime = now + config.interval;
    }
    if (tracker.count < config.maxEvents) {
      tracker.count++;
      return true;
    }
    return false;
  }
  aggregate(event, data) {
    if (!this.isWithinRateLimit(event)) return false;
    this.buffer[event] = data;
    return true;
  }
  sendAggregated(socket, event, data) {
    if (this.timers[event]) clearTimeout(this.timers[event]);
    this.timers[event] = setTimeout(() => {
      socket.emit(event, data);
      delete this.buffer[event];
    }, 120);
  }
  clear() {
    Object.values(this.timers).forEach(clearTimeout);
    this.buffer = {};
    this.timers = {};
  }
}

// ===============================
// CONEXÃO BULL-EX
// ===============================
function connectToBullEx(ssid, clientSocket) {
  const shortId = clientSocket.id.slice(0, 8);
  console.log(`📌 [${shortId}] Iniciando autenticação BullEx...`);

  const ws = new WebSocket("wss://ws.trade.bull-ex.com/echo/websocket", {
    headers: {
      Origin: "https://trade.bull-ex.com",
      "User-Agent": "Mozilla/5.0",
    },
  });

  const aggregator = new EventAggregator(clientSocket.id);
  let subscribedActive = null;
  let pingInterval = null;

  ws.on("open", () => {
    console.log(`✅ [${shortId}] Conectado — autenticando...`);
    ws.send(JSON.stringify({ name: "authenticate", msg: { ssid, protocol: 3, client_session_id: "" } }));
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ name: "ping" }));
    }, 20000);
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    const event = data.name || "unknown";

    // ---- Eventos principais ----
    if (event === "authenticated") {
      console.log(`🎯 [${shortId}] Autenticado com sucesso`);
      clientSocket.emit("authenticated", data);

      // Solicita saldo e posições iniciais
      ws.send(JSON.stringify({ name: "balances.get-balances", msg: {} }));
      ws.send(JSON.stringify({ name: "subscribe-positions", msg: {} }));
      return;
    }

    if (event === "balance-changed") {
      const balanceAmount = data?.msg?.current_balance?.amount;
      if (balanceAmount) {
        clientBalances.set(clientSocket.id, balanceAmount);
        clientSocket.emit("balance", data);
        clientSocket.emit("current-balance", {
          amount: balanceAmount,
          currency: data?.msg?.current_balance?.currency || "USD",
        });
      }
      return;
    }

    if (event === "candles-generated") {
      if (aggregator.aggregate(event, data)) {
        aggregator.sendAggregated(clientSocket, "candles", data);
      }
      return;
    }

    if (event === "position-changed") {
      clientSocket.emit("position-changed", data);
      return;
    }

    clientSocket.emit(event, data);
  });

  ws.on("close", () => {
    console.warn(`🔴 [${shortId}] Conexão encerrada`);
    clearInterval(pingInterval);
    aggregator.clear();
    clientBalances.delete(clientSocket.id);
    clientSocket.emit("disconnected");
  });

  // ======= Eventos do cliente =======
  clientSocket.on("subscribe-active", ({ active }) => {
    if (!active) return;
    const unsub = subscribedActive
      ? JSON.stringify({ name: "unsubscribe-candles", msg: { active_id: subscribedActive } })
      : null;

    if (unsub) {
      console.log(`🧹 [${shortId}] Unsubscribed candles for active ${subscribedActive}`);
      ws.send(unsub);
    }

    subscribedActive = active;
    console.log(`📡 [${shortId}] Subscribed candles for ${active}`);
    ws.send(JSON.stringify({ name: "subscribe-candles", msg: { active_id: active } }));
    clientSocket.emit("subscribed-active", [{ name: active }]);
  });

  clientSocket.on("sendMessage", (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data.msg || data));
    }
  });

  connections.set(clientSocket.id, { ws, aggregator });
}

// ===============================
// SOCKET.IO
// ===============================
io.on("connection", (socket) => {
  const shortId = socket.id.slice(0, 8);
  console.log(`✅ Cliente conectado: ${shortId}`);

  socket.on("authenticate", ({ ssid }) => {
    if (!ssid) return socket.emit("error", { message: "SSID ausente" });
    connectToBullEx(ssid, socket);
  });

  socket.on("disconnect", () => {
    const connection = connections.get(socket.id);
    if (connection) connection.ws.close();
    connections.delete(socket.id);
    clientBalances.delete(socket.id);
    console.log(`❌ [${shortId}] Desconectado`);
  });
});

app.get("/", (req, res) => res.json({ status: "ok", msg: "Proxy ativo", connections: connections.size }));
