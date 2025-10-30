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

const connections = new Map();
const clientBalances = new Map();

// ====== RATE LIMITING ======
const RATE_LIMITS = {
  "candles-generated": { interval: 500, maxEvents: 5 },
  "price-splitter.client-buyback-generated": { interval: 1000, maxEvents: 3 },
  "positions-state": { interval: 1000, maxEvents: 10 },
  "balance-changed": { interval: 500, maxEvents: 10 },
};

// ====== EVENT AGGREGATOR ======
class EventAggregator {
  constructor(clientId) {
    this.clientId = clientId;
    this.buffer = {};
    this.timers = {};
    this.rateLimitTrackers = {};
    Object.keys(RATE_LIMITS).forEach((event) => {
      this.rateLimitTrackers[event] = { count: 0, resetTime: 0 };
    });
  }

  isWithinRateLimit(eventName) {
    const config = RATE_LIMITS[eventName];
    if (!config) return true;
    const now = Date.now();
    const tracker = this.rateLimitTrackers[eventName];
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

  aggregate(eventName, data) {
    if (!this.isWithinRateLimit(eventName)) return false;
    this.buffer[eventName] = data;
    return true;
  }

  sendAggregated(socket, emitNameForClient, data, originalEventName) {
    if (this.timers[emitNameForClient]) clearTimeout(this.timers[emitNameForClient]);
    this.timers[emitNameForClient] = setTimeout(() => {
      socket.emit(emitNameForClient, data);
      if (originalEventName && originalEventName !== emitNameForClient) {
        socket.emit(originalEventName, data);
      }
      delete this.buffer[emitNameForClient];
    }, 100);
  }

  clear() {
    Object.values(this.timers).forEach(clearTimeout);
    this.buffer = {};
    this.timers = {};
  }
}

// ====== CONEXÃO BULL-EX ======
function connectToBullEx(ssid, clientSocket) {
  const shortId = clientSocket.id.substring(0, 8);
  console.log(`📌 [${shortId}] Iniciando autenticação com BullEx...`);

  const bullexWs = new WebSocket("wss://ws.trade.bull-ex.com/echo/websocket", {
    headers: {
      Origin: "https://trade.bull-ex.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });

  const aggregator = new EventAggregator(clientSocket.id);
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  let pingInterval = null;
  const silentEvents = ["ping", "pong", "timeSync"];

  bullexWs.on("open", () => {
    console.log(`✅ [${shortId}] Conectado à BullEx. Enviando autenticação...`);
    reconnectAttempts = 0;
    bullexWs.send(
      JSON.stringify({
        name: "authenticate",
        msg: { ssid, protocol: 3, client_session_id: "" },
      })
    );
    pingInterval = setInterval(() => {
      if (bullexWs.readyState === WebSocket.OPEN) {
        bullexWs.send(JSON.stringify({ name: "ping" }));
      }
    }, 20000);
  });

  bullexWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      const event = data.name || "unknown";
      if (!silentEvents.includes(event)) console.log(`📨 [${shortId}] Evento: ${event}`);

      // ====== AUTENTICAÇÃO ======
      if (event === "authenticated") {
        console.log(`🎯 [${shortId}] Autenticado com sucesso!`);
        clientSocket.emit("authenticated", data);
        return;
      }
      if (event === "unauthorized") {
        console.warn(`🚫 [${shortId}] SSID inválido.`);
        clientSocket.emit("unauthorized", data);
        return;
      }

      // ====== PING/PONG ======
      if (event === "ping") {
        bullexWs.send(JSON.stringify({ name: "pong" }));
        return;
      }
      if (event === "pong" || event === "timeSync") return;

      // ====== HANDSHAKE FRONT ======
      if (event === "front") {
        console.log(`🔄 [${shortId}] Evento 'front' recebido`);
        clientSocket.emit("front", data);
        return;
      }

      // ====== SALDO ======
      if (event === "balance-changed" || event === "balances") {
        const balanceAmount = data?.msg?.current_balance?.amount;
        if (balanceAmount) {
          const balanceObj = data?.msg?.current_balance;
          console.log(`💰 [${shortId}] Saldo detectado: $${(balanceAmount / 100).toFixed(2)}`);
          clientBalances.set(clientSocket.id, balanceAmount);

          // Salva user_balance_id na conexão para abrir ordens depois
          if (balanceObj?.id) {
            const conn = connections.get(clientSocket.id);
            if (conn) conn.user_balance_id = balanceObj.id;
          }

          clientSocket.emit("balance-changed", data);
          clientSocket.emit("balance", data);
          clientSocket.emit("current-balance", {
            msg: {
              current_balance: {
                amount: balanceAmount,
                currency: balanceObj?.currency || "USD",
                timestamp: Date.now(),
              },
            },
          });
        }
        return;
      }

      // ====== ORDENS ======
      if (event === "position-changed") {
        const status = data.msg?.status;
        const result = data.msg?.result;
        if (status === "closed") {
          console.log(`${result === "win" ? "✅" : "❌"} [${shortId}] ${result}`);
        }
        clientSocket.emit("position-changed", data);
        return;
      }

      // ====== CANDLES E OUTROS EVENTOS ======
      if (event === "candles-generated" || event === "candle-generated") {
        if (aggregator.aggregate(event, data)) {
          aggregator.sendAggregated(clientSocket, "candles", data, event);
        }
        return;
      }

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

      // ====== REEMITIR GERAL ======
      clientSocket.emit(event, data);
    } catch (err) {
      console.error(`⚠️ [${shortId}] Erro: ${err.message}`);
    }
  });

  bullexWs.on("close", () => {
    console.warn(`🔴 [${shortId}] Conexão encerrada`);
    if (pingInterval) clearInterval(pingInterval);
    aggregator.clear();
    clientBalances.delete(clientSocket.id);
    clientSocket.emit("disconnected");

    if (reconnectAttempts < maxReconnectAttempts && clientSocket.connected) {
      reconnectAttempts++;
      console.log(`🔄 [${shortId}] Reconectando ${reconnectAttempts}/${maxReconnectAttempts}...`);
      setTimeout(() => connectToBullEx(ssid, clientSocket), 4000);
    }
  });

  bullexWs.on("error", (err) => {
    console.error(`⚠️ [${shortId}] Erro: ${err.message}`);
    clientSocket.emit("error", { message: err.message });
  });

  connections.set(clientSocket.id, { ws: bullexWs, aggregator, ssid });
}

// ====== SOCKET.IO ======
io.on("connection", (clientSocket) => {
  const shortId = clientSocket.id.substring(0, 8);
  console.log(`✅ Cliente conectado: ${shortId}`);

  clientSocket.on("authenticate", ({ ssid }) => {
    if (!ssid) return clientSocket.emit("error", { message: "SSID não fornecido" });
    connectToBullEx(ssid, clientSocket);
  });

  clientSocket.on("sendMessage", (envelope) => {
    const connection = connections.get(clientSocket.id);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      clientSocket.emit("error", { message: "WebSocket não conectado" });
      return;
    }
    const toSend = envelope.msg ? envelope.msg : envelope;
    connection.ws.send(JSON.stringify(toSend));
    console.log(`📤 [${shortId}] Reenviando: ${toSend.name || toSend.msg?.name || "message"}`);
  });

  clientSocket.on("get-balance", () => {
    const balance = clientBalances.get(clientSocket.id);
    if (balance !== undefined) {
      clientSocket.emit("balance", {
        msg: { current_balance: { amount: balance, currency: "USD" } },
      });
    }
  });

  clientSocket.on("disconnect", () => {
    const conn = connections.get(clientSocket.id);
    if (conn) {
      conn.ws.close();
      conn.aggregator.clear();
      connections.delete(clientSocket.id);
    }
    clientBalances.delete(clientSocket.id);
    console.log(`❌ [${shortId}] Desconectado`);
  });
});

// ====== ENDPOINT PARA ABRIR ORDENS ======
app.post("/open", (req, res) => {
  const { socketId, ssid, direction, stake, activeId, timeframe = "M1", customSeconds = 5 } = req.body;
  let connEntry = socketId ? connections.get(socketId) : Array.from(connections.values()).find((c) => c.ssid === ssid);

  if (!connEntry || !connEntry.ws || connEntry.ws.readyState !== WebSocket.OPEN)
    return res.status(400).json({ ok: false, error: "Conexão não encontrada/aberta" });

  const now = Math.floor(Date.now() / 1000);
  let optionTypeId = 3, expired = now + customSeconds;
  if (timeframe === "M1") expired = Math.ceil(now / 60) * 60;
  if (timeframe === "M5") expired = Math.ceil(now / 300) * 300;

  const user_balance_id = connEntry.user_balance_id;
  if (!user_balance_id) return res.status(400).json({ ok: false, error: "user_balance_id ausente" });

  const payload = {
    name: "binary-options.open-option",
    version: "2.0",
    body: {
      user_balance_id,
      active_id: activeId,
      option_type_id: optionTypeId,
      direction,
      expired,
      price: Math.round(stake * 100),
      value: Math.round(stake * 100),
      profit_percent: 88,
      refund_value: 0,
    },
  };

  try {
    connEntry.ws.send(JSON.stringify(payload));
    console.log(`🎯 Ordem enviada para BullEx: ${direction} ${activeId} $${stake}`);
    return res.json({ ok: true, sent: payload });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== HEALTHCHECK ======
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
app.get("/", (req, res) =>
  res.json({ message: "Proxy BullEx Saldo Real ✅", status: "ok", connections: connections.size })
);
