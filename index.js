// ==============================================
// PROXY BULL-EX — V3.5 ESTÁVEL (ANTI-DROP)
// ==============================================
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

const RATE_LIMITS = {
  "candles-generated": { interval: 400, maxEvents: 3 },
  "positions-state": { interval: 1000, maxEvents: 6 },
  "balance-changed": { interval: 1000, maxEvents: 6 },
};

class EventAggregator {
  constructor(clientId) {
    this.clientId = clientId;
    this.buffer = {};
    this.timers = {};
    this.rateTrackers = {};
    Object.keys(RATE_LIMITS).forEach((e) => {
      this.rateTrackers[e] = { count: 0, resetTime: 0 };
    });
  }
  isWithinRateLimit(event) {
    const cfg = RATE_LIMITS[event];
    if (!cfg) return true;
    const now = Date.now();
    const tracker = this.rateTrackers[event];
    if (now > tracker.resetTime) {
      tracker.count = 0;
      tracker.resetTime = now + cfg.interval;
    }
    if (tracker.count < cfg.maxEvents) {
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
    }, 80);
  }
  clear() {
    Object.values(this.timers).forEach(clearTimeout);
  }
}

// ==============================================
// CONEXÃO BULL-EX
// ==============================================
function connectToBullEx(ssid, clientSocket) {
  const shortId = clientSocket.id.slice(0, 8);
  console.log(`📌 [${shortId}] Iniciando autenticação BullEx...`);

  const ws = new WebSocket("wss://ws.trade.bull-ex.com/echo/websocket", {
    headers: {
      Origin: "https://trade.bull-ex.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });

  const aggregator = new EventAggregator(clientSocket.id);
  let subscribedActive = null;
  let pingInterval = null;
  let reconnectAttempts = 0;

  ws.on("open", () => {
    console.log(`✅ [${shortId}] Conectado à BullEx. Autenticando...`);
    reconnectAttempts = 0;
    ws.send(JSON.stringify({ name: "authenticate", msg: { ssid, protocol: 3, client_session_id: "" } }));

    // Mantém vivo o WS com a BullEx
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ name: "ping" }));
      }
    }, 20000);
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    const event = data.name || "unknown";

    if (event === "ping") {
      ws.send(JSON.stringify({ name: "pong" }));
      return;
    }
    if (event === "timeSync") return; // não repassar spam

    if (event === "authenticated") {
      console.log(`🎯 [${shortId}] Autenticado BullEx`);
      clientSocket.emit("authenticated", data);
      ws.send(JSON.stringify({ name: "balances.get-balances", msg: {} }));
      ws.send(JSON.stringify({ name: "subscribe-positions", msg: {} }));
      return;
    }

    if (event === "balance-changed") {
      const balance = data?.msg?.current_balance?.amount;
      if (balance) {
        clientBalances.set(clientSocket.id, balance);
        clientSocket.emit("balance-changed", data);
        clientSocket.emit("current-balance", {
          amount: balance,
          currency: data?.msg?.current_balance?.currency || "USD",
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (event === "candles-generated") {
      if (aggregator.aggregate(event, data))
        aggregator.sendAggregated(clientSocket, "candles", data);
      return;
    }

    clientSocket.emit(event, data);
  });

  ws.on("close", () => {
    console.warn(`🔴 [${shortId}] Conexão BullEx encerrada`);
    clearInterval(pingInterval);
    aggregator.clear();
    clientBalances.delete(clientSocket.id);
    clientSocket.emit("disconnected");

    // Tentativa de reconexão automática
    if (reconnectAttempts < 5) {
      reconnectAttempts++;
      console.log(`🔁 [${shortId}] Tentando reconectar (${reconnectAttempts}/5)...`);
      setTimeout(() => connectToBullEx(ssid, clientSocket), 4000);
    }
  });

  ws.on("error", (err) => {
    console.error(`⚠️ [${shortId}] Erro WS: ${err.message}`);
  });

  // ============ Canal: Ativo selecionado ============
  clientSocket.on("subscribe-active", ({ active }) => {
    if (!active) return;
    if (subscribedActive) {
      ws.send(JSON.stringify({ name: "unsubscribe-candles", msg: { active_id: subscribedActive } }));
      console.log(`🧹 [${shortId}] Unsubscribed ${subscribedActive}`);
    }
    subscribedActive = active;
    ws.send(JSON.stringify({ name: "subscribe-candles", msg: { active_id: active } }));
    console.log(`📡 [${shortId}] Subscribed ${active}`);
    clientSocket.emit("subscribed-active", [{ name: active }]);
  });

  // ============ Canal: Ordens ============
  clientSocket.on("sendMessage", (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data.msg || data));
      console.log(`📤 [${shortId}] Reenviando -> ${data.msg?.name || "message"}`);
    }
  });

  // Mantém o socket.io vivo
  const heartbeat = setInterval(() => {
    if (clientSocket.connected) clientSocket.emit("ping-proxy", { t: Date.now() });
  }, 15000);

  clientSocket.on("disconnect", () => {
    clearInterval(heartbeat);
    clearInterval(pingInterval);
    if (ws.readyState === WebSocket.OPEN) ws.close();
    connections.delete(clientSocket.id);
    console.log(`❌ [${shortId}] Desconectado`);
  });

  connections.set(clientSocket.id, { ws, aggregator });
}

// ==============================================
// SOCKET.IO
// ==============================================
io.on("connection", (socket) => {
  const shortId = socket.id.slice(0, 8);
  console.log(`✅ Cliente conectado: ${shortId}`);

  socket.on("authenticate", ({ ssid }) => {
    if (!ssid) {
      socket.emit("error", { message: "SSID não fornecido" });
      return;
    }
    connectToBullEx(ssid, socket);
  });
});

app.get("/", (req, res) =>
  res.json({ status: "ok", msg: "Proxy BullEx rodando 🔥", connections: connections.size })
);
