// ==============================================
// PROXY BULL-EX — V4.0 ESTÁVEL (COM CANDLES ATIVOS)
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
const io = new Server(server, { cors: { origin: "*" } });

// ======= MAPA DE ATIVOS BULL-EX =======
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
  "BTCUSD-OTC": 90,
  "ETHUSD-OTC": 91,
  "USDNOK-OTC": 92,
  "USDSEK-OTC": 93,
  "USDTRY-OTC": 94,
};

const connections = new Map();
const clientBalances = new Map();

// ====== RATE LIMITS ======
const RATE_LIMITS = {
  "candles-generated": { interval: 400, maxEvents: 3 },
  "positions-state": { interval: 1000, maxEvents: 6 },
  "balance-changed": { interval: 1000, maxEvents: 6 },
};

class EventAggregator {
  constructor(id) {
    this.id = id;
    this.buffer = {};
    this.timers = {};
    this.trackers = {};
    Object.keys(RATE_LIMITS).forEach(
      (e) => (this.trackers[e] = { count: 0, resetTime: 0 })
    );
  }
  isWithinLimit(event) {
    const cfg = RATE_LIMITS[event];
    if (!cfg) return true;
    const now = Date.now();
    const tracker = this.trackers[event];
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
    if (!this.isWithinLimit(event)) return false;
    this.buffer[event] = data;
    return true;
  }
  send(socket, event, data) {
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

// ===================================================
// CONEXÃO COM A BULL-EX
// ===================================================
function connectToBullEx(ssid, socket) {
  const shortId = socket.id.slice(0, 8);
  console.log(`📌 [${shortId}] Autenticando BullEx...`);

  const ws = new WebSocket("wss://ws.trade.bull-ex.com/echo/websocket", {
    headers: { Origin: "https://trade.bull-ex.com" },
  });

  const aggregator = new EventAggregator(socket.id);
  let activeSub = null;
  let pingInterval = null;

  ws.on("open", () => {
    console.log(`✅ [${shortId}] Conectado à BullEx.`);
    ws.send(JSON.stringify({ name: "authenticate", msg: { ssid, protocol: 3 } }));

    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ name: "ping" }));
    }, 20000);
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    const event = data.name;

    if (event === "ping") {
      ws.send(JSON.stringify({ name: "pong" }));
      return;
    }
    if (event === "timeSync") return;

    if (event === "authenticated") {
      console.log(`🎯 [${shortId}] Autenticado BullEx`);
      socket.emit("authenticated", data);
      ws.send(JSON.stringify({ name: "balances.get-balances" }));
      ws.send(JSON.stringify({ name: "subscribe-positions" }));
      return;
    }

    if (event === "balance-changed") {
      const amount = data?.msg?.current_balance?.amount;
      if (amount) {
        clientBalances.set(socket.id, amount);
        socket.emit("balance", data);
      }
      return;
    }

    if (event === "candles-generated") {
      if (aggregator.aggregate(event, data))
        aggregator.send(socket, "candles", data);
      return;
    }

    socket.emit(event, data);
  });

  // ==============================================
  // TROCA DE ATIVO (CANDLES)
  // ==============================================
  socket.on("subscribe-active", ({ active }) => {
    const short = socket.id.slice(0, 8);
    const id = ACTIVE_MAP[active];
    if (!id) {
      console.warn(`⚠️ [${short}] Ativo inválido: ${active}`);
      return;
    }

    if (activeSub) {
      ws.send(JSON.stringify({ name: "unsubscribe-candles", msg: { active_id: activeSub } }));
      console.log(`🧹 [${short}] Unsubscribed ${activeSub}`);
    }

    activeSub = id;
    ws.send(JSON.stringify({ name: "subscribe-candles", msg: { active_id: id } }));
    console.log(`📡 [${short}] Subscribed ${active}`);
    socket.emit("subscribed-active", [{ name: active, id }]);
  });

  // ==============================================
  // ORDENS
  // ==============================================
  socket.on("sendMessage", (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data.msg || data));
      console.log(`📤 [${shortId}] Reenviando -> ${data.msg?.name || "message"}`);
    }
  });

  // ==============================================
  // DESCONECTAR
  // ==============================================
  socket.on("disconnect", () => {
    clearInterval(pingInterval);
    aggregator.clear();
    if (ws.readyState === WebSocket.OPEN) ws.close();
    connections.delete(socket.id);
    console.log(`❌ [${shortId}] Cliente desconectado`);
  });

  connections.set(socket.id, { ws, aggregator });
}

// ==============================================
// SOCKET.IO HANDLER
// ==============================================
io.on("connection", (socket) => {
  const shortId = socket.id.slice(0, 8);
  console.log(`✅ Cliente conectado: ${shortId}`);

  socket.on("authenticate", ({ ssid }) => {
    if (!ssid) {
      socket.emit("error", { message: "SSID ausente" });
      return;
    }
    connectToBullEx(ssid, socket);
  });
});

app.get("/", (req, res) =>
  res.json({
    status: "ok",
    message: "Proxy BullEx 4.0 rodando 🚀",
    connections: connections.size,
  })
);
