import express from "express";
import { Server } from "socket.io";
import cors from "cors";
import WebSocket from "ws";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy BullEx ativo e escutando em 0.0.0.0:${PORT}`);
});

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

const connections = new Map();

// ====== CONFIGURAÇÕES DE RATE LIMITING ======
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

    if (["candles-generated", "price-splitter.client-buyback-generated"].includes(eventName)) {
      this.buffer[eventName] = data;
      return true;
    }

    return true;
  }

  sendAggregated(socket, eventName, data) {
    if (this.timers[eventName]) clearTimeout(this.timers[eventName]);
    this.timers[eventName] = setTimeout(() => {
      socket.emit(eventName, data);
      delete this.buffer[eventName];
    }, 100);
  }

  clear() {
    Object.values(this.timers).forEach(clearTimeout);
    this.buffer = {};
    this.timers = {};
  }
}

// ====== CONEXÃO COM BULLEX ======
function connectToBullEx(ssid, clientSocket) {
  console.log(`📌 [${clientSocket.id.substring(0, 8)}] Iniciando autenticação com BullEx...`);

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
    console.log(`✅ [${clientSocket.id.substring(0, 8)}] Conectado à BullEx. Enviando autenticação...`);
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

      if (!silentEvents.includes(event)) {
        console.log(`📨 [${clientSocket.id.substring(0, 8)}] Evento recebido: ${event}`);
      }

      switch (event) {
        case "authenticated":
          console.log(`🎯 [${clientSocket.id.substring(0, 8)}] Autenticado com sucesso!`);
          clientSocket.emit("authenticated", data);
          break;

        case "unauthorized":
          console.warn(`🚫 [${clientSocket.id.substring(0, 8)}] SSID inválido.`);
          clientSocket.emit("unauthorized", data);
          break;

        case "ping":
          bullexWs.send(JSON.stringify({ name: "pong" }));
          break;

        case "candles-generated":
          if (aggregator.aggregate(event, data)) aggregator.sendAggregated(clientSocket, "candles", data);
          break;

        case "price-splitter.client-buyback-generated":
          if (aggregator.aggregate(event, data)) aggregator.sendAggregated(clientSocket, "pressure", data);
          break;

        case "positions-state":
          if (aggregator.aggregate(event, data)) aggregator.sendAggregated(clientSocket, "positions", data);
          break;

        case "balance-changed":
          clientSocket.emit("balance", data);
          break;

        case "position-changed":
          clientSocket.emit("position-changed", data);
          break;

        default:
          clientSocket.emit(event, data);
          break;
      }
    } catch (err) {
      console.error(`⚠️ Erro parseando mensagem: ${err.message}`);
    }
  });

  bullexWs.on("close", () => {
    console.warn(`🔴 [${clientSocket.id.substring(0, 8)}] Conexão BullEx encerrada.`);
    if (pingInterval) clearInterval(pingInterval);
    aggregator.clear();
    clientSocket.emit("disconnected");

    if (reconnectAttempts < maxReconnectAttempts && clientSocket.connected) {
      reconnectAttempts++;
      console.log(`🔄 Tentando reconectar (${reconnectAttempts}/${maxReconnectAttempts})...`);
      setTimeout(() => connectToBullEx(ssid, clientSocket), 4000);
    } else {
      clientSocket.emit("error", { message: "Falha de conexão permanente" });
    }
  });

  bullexWs.on("error", (err) => {
    console.error(`⚠️ Erro BullEx: ${err.message}`);
    clientSocket.emit("error", { message: err.message });
  });

  connections.set(clientSocket.id, { ws: bullexWs, aggregator });
}

// ====== SOCKET.IO ======
io.on("connection", (clientSocket) => {
  console.log(`✅ Cliente conectado: ${clientSocket.id.substring(0, 8)}`);

  clientSocket.on("authenticate", ({ ssid }) => {
    if (!ssid) {
      clientSocket.emit("error", { message: "SSID não fornecido" });
      return;
    }
    connectToBullEx(ssid, clientSocket);
  });

  clientSocket.on("sendMessage", (data) => {
    const connection = connections.get(clientSocket.id);
    if (connection && connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify(data.msg || data));
    } else {
      clientSocket.emit("error", { message: "WebSocket não conectado" });
    }
  });

  clientSocket.on("disconnect", () => {
    const connection = connections.get(clientSocket.id);
    if (connection) {
      connection.ws.close();
      connection.aggregator.clear();
      connections.delete(clientSocket.id);
    }
    console.log(`❌ Cliente desconectado: ${clientSocket.id.substring(0, 8)}`);
  });
});

// ====== ENDPOINTS ======
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
  res.json({ message: "Proxy BullEx Login Corrigido ✅", status: "ok", connections: connections.size })
);
