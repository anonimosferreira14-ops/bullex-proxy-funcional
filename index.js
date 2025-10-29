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
  let isAuthenticated = false;

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

      if (!silentEvents.includes(event)) {
        console.log(`📨 [${shortId}] Evento: ${event}`);
      }

      switch (event) {
        case "authenticated":
          console.log(`🎯 [${shortId}] Autenticado com sucesso!`);
          isAuthenticated = true;
          clientSocket.emit("authenticated", data);

          // 🔥 SINCRONIZAR PERFIL E SALDO AUTOMATICAMENTE
          console.log(`📡 [${shortId}] Solicitando sincronização de dados...`);
          
          setTimeout(() => {
            bullexWs.send(
              JSON.stringify({
                name: "profile",
                msg: {
                  request_id: `sync-profile-${Date.now()}`,
                  local_time: Date.now(),
                },
              })
            );

            bullexWs.send(
              JSON.stringify({
                name: "get-balances",
                msg: {
                  request_id: `sync-balance-${Date.now()}`,
                  local_time: Date.now(),
                },
              })
            );
          }, 500);
          break;

        case "unauthorized":
          console.warn(`🚫 [${shortId}] SSID inválido.`);
          clientSocket.emit("unauthorized", data);
          break;

        case "ping":
          bullexWs.send(JSON.stringify({ name: "pong" }));
          break;

        // ====== EVENTOS DE PERFIL E SALDO ======
        case "profile":
          console.log(`👤 [${shortId}] Perfil recebido`);
          clientSocket.emit("profile", data);
          break;

        case "get-balances":
          console.log(`💰 [${shortId}] Saldos recebidos`);
          clientSocket.emit("balances", data);
          break;

        // ====== HIGH-FREQUENCY EVENTS (agregados) ======
        case "candles-generated":
          if (aggregator.aggregate(event, data)) {
            aggregator.sendAggregated(clientSocket, "candles", data);
          }
          break;

        case "price-splitter.client-buyback-generated":
          if (aggregator.aggregate(event, data)) {
            aggregator.sendAggregated(clientSocket, "pressure", data);
          }
          break;

        case "positions-state":
          if (aggregator.aggregate(event, data)) {
            aggregator.sendAggregated(clientSocket, "positions", data);
          }
          break;

        // ====== EVENTOS CRÍTICOS (imediatos) ======
        case "balance-changed":
          console.log(`💵 [${shortId}] Saldo alterado`);
          clientSocket.emit("balance", data);
          break;

        case "position-changed":
          const status = data.msg?.status;
          const result = data.msg?.result;
          if (status === "closed") {
            console.log(`${result === "win" ? "✅" : "❌"} [${shortId}] Posição ${result}`);
          }
          clientSocket.emit("position-changed", data);
          break;

        case "front":
          console.log(`🔄 [${shortId}] Evento 'front' recebido`);
          clientSocket.emit("front", data);
          break;

        case "result":
          console.log(`📊 [${shortId}] Resultado recebido`);
          clientSocket.emit("result", data);
          break;

        default:
          // Reemitir outros eventos
          clientSocket.emit(event, data);
          break;
      }
    } catch (err) {
      console.error(`⚠️ [${shortId}] Erro parseando mensagem: ${err.message}`);
    }
  });

  bullexWs.on("close", () => {
    console.warn(`🔴 [${shortId}] Conexão BullEx encerrada.`);
    if (pingInterval) clearInterval(pingInterval);
    aggregator.clear();
    clientSocket.emit("disconnected");

    if (reconnectAttempts < maxReconnectAttempts && clientSocket.connected) {
      reconnectAttempts++;
      console.log(`🔄 [${shortId}] Reconectando (${reconnectAttempts}/${maxReconnectAttempts})...`);
      setTimeout(() => connectToBullEx(ssid, clientSocket), 4000);
    } else if (reconnectAttempts >= maxReconnectAttempts) {
      console.error(`❌ [${shortId}] Máximo de reconexões atingido`);
      clientSocket.emit("error", { message: "Falha de conexão permanente" });
    }
  });

  bullexWs.on("error", (err) => {
    console.error(`⚠️ [${shortId}] Erro BullEx: ${err.message}`);
    clientSocket.emit("error", { message: err.message });
  });

  connections.set(clientSocket.id, { ws: bullexWs, aggregator });
}

// ====== SOCKET.IO ======
io.on("connection", (clientSocket) => {
  const shortId = clientSocket.id.substring(0, 8);
  console.log(`✅ Cliente conectado: ${shortId}`);

  clientSocket.on("authenticate", ({ ssid }) => {
    if (!ssid) {
      console.warn(`⚠️ [${shortId}] SSID não fornecido`);
      clientSocket.emit("error", { message: "SSID não fornecido" });
      return;
    }
    connectToBullEx(ssid, clientSocket);
  });

  clientSocket.on("sendMessage", (data) => {
    const connection = connections.get(clientSocket.id);
    if (connection && connection.ws.readyState === WebSocket.OPEN) {
      console.log(`📤 [${shortId}] Reenviando: ${data.msg?.name || "message"}`);
      connection.ws.send(JSON.stringify(data.msg || data));
    } else {
      console.warn(`⚠️ [${shortId}] WebSocket não conectado`);
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
    console.log(`❌ [${shortId}] Desconectado`);
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
  res.json({ message: "Proxy BullEx v3 com Sync Automático ✅", status: "ok", connections: connections.size })
);
