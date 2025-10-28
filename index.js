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
  "candles-generated": { interval: 500, maxEvents: 5 }, // Max 5 eventos a cada 500ms
  "price-splitter.client-buyback-generated": { interval: 1000, maxEvents: 3 }, // Max 3 a cada 1s
  "positions-state": { interval: 1000, maxEvents: 10 },
  "balance-changed": { interval: 500, maxEvents: 10 },
};

// ====== EVENT AGGREGATOR (Agrupa eventos similares) ======
class EventAggregator {
  constructor(clientId) {
    this.clientId = clientId;
    this.buffer = {};
    this.timers = {};
    this.rateLimitTrackers = {};

    // Inicializar rate limiters
    Object.keys(RATE_LIMITS).forEach((event) => {
      this.rateLimitTrackers[event] = { count: 0, resetTime: 0 };
    });
  }

  // Verificar rate limit
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

  // Agregar evento
  aggregate(eventName, data) {
    // Se não estiver no rate limit, descartar
    if (!this.isWithinRateLimit(eventName)) {
      return false; // Silenciosamente ignorado
    }

    // Candles: apenas enviar o último
    if (eventName === "candles-generated") {
      this.buffer[eventName] = data;
      return true;
    }

    // Pressure: manter atualizado
    if (eventName === "price-splitter.client-buyback-generated") {
      this.buffer[eventName] = data;
      return true;
    }

    return true;
  }

  // Enviar evento agregado
  sendAggregated(socket, eventName, data) {
    // Limpar timer anterior se houver
    if (this.timers[eventName]) {
      clearTimeout(this.timers[eventName]);
    }

    // Agendar envio após 100ms (batching)
    this.timers[eventName] = setTimeout(() => {
      socket.emit(eventName, data);
      delete this.buffer[eventName];
    }, 100);
  }

  // Limpar
  clear() {
    Object.values(this.timers).forEach((timer) => clearTimeout(timer));
    this.buffer = {};
    this.timers = {};
  }
}

// ====== FUNCTION: Conectar à BullEx ======
function connectToBullEx(ssid, clientSocket) {
  console.log(`📌 [${clientSocket.id.substring(0, 8)}] Autenticando com BullEx...`);

  const bullexWs = new WebSocket("wss://ws.trade.bull-ex.com/echo/websocket");
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  let pingInterval = null;

  // Agregador de eventos
  const aggregator = new EventAggregator(clientSocket.id);

  // Eventos que NÃO precisam de log
  const silentEvents = [
    "timeSync",
    "pong",
    "ping",
    "candles-generated",
    "price-splitter.client-buyback-generated",
    "positions-state",
  ];

  bullexWs.on("open", () => {
    console.log(`✅ [${clientSocket.id.substring(0, 8)}] WebSocket aberto. Autenticando...`);
    reconnectAttempts = 0;

    bullexWs.send(
      JSON.stringify({
        name: "authenticate",
        msg: { ssid, protocol: 3 },
      })
    );

    // Heartbeat a cada 20s
    pingInterval = setInterval(() => {
      if (bullexWs.readyState === WebSocket.OPEN) {
        bullexWs.send(JSON.stringify({ name: "ping" }));
      }
    }, 20000);
  });

  bullexWs.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      const eventName = data.name || "unknown";

      // Log apenas eventos importantes
      if (!silentEvents.includes(eventName)) {
        console.log(`📨 [${clientSocket.id.substring(0, 8)}] ${eventName}`);
      }

      switch (eventName) {
        case "authenticated":
          console.log(`🎯 [${clientSocket.id.substring(0, 8)}] Autenticado com sucesso!`);
          clientSocket.emit("authenticated", data);
          break;

        case "unauthorized":
          console.warn(`🚫 [${clientSocket.id.substring(0, 8)}] SSID inválido`);
          clientSocket.emit("unauthorized", data);
          break;

        case "ping":
          bullexWs.send(JSON.stringify({ name: "pong" }));
          break;

        case "pong":
        case "timeSync":
          // Ignorar silenciosamente
          break;

        // ====== TRATAMENTO DE HIGH-FREQUENCY DATA ======

        case "candles-generated":
          // Agregar candles (enviar apenas os últimos)
          if (aggregator.aggregate(eventName, data)) {
            aggregator.sendAggregated(clientSocket, "candles", data);
          }
          break;

        case "price-splitter.client-buyback-generated":
          // Agregar pressure (call/put)
          if (aggregator.aggregate(eventName, data)) {
            aggregator.sendAggregated(clientSocket, "pressure", data);
          }
          break;

        case "positions-state":
          // Posições: enviar com throttle
          if (aggregator.aggregate(eventName, data)) {
            aggregator.sendAggregated(clientSocket, "positions", data);
          }
          break;

        // ====== EVENTOS CRÍTICOS (Enviar imediatamente) ======

        case "balance-changed":
          // Sempre enviar imediatamente (importante!)
          clientSocket.emit("balance", data);
          console.log(`💰 [${clientSocket.id.substring(0, 8)}] Saldo: ${data.msg?.current_balance?.amount || "N/A"}`);
          break;

        case "position-changed":
          // Sempre enviar imediatamente (crítico!)
          const status = data.msg?.status;
          const result = data.msg?.result;
          if (status === "closed") {
            console.log(`${result === "win" ? "✅" : "❌"} [${clientSocket.id.substring(0, 8)}] Posição ${result}`);
          }
          clientSocket.emit("position-changed", data);
          break;

        case "result":
          // Resultado de operação
          clientSocket.emit("result", data);
          break;

        default:
          // Eventos desconhecidos: enviar mas com log
          clientSocket.emit("event", data);
          break;
      }
    } catch (err) {
      console.error(
        `⚠️ [${clientSocket.id.substring(0, 8)}] Erro ao parsear:`,
        err.message
      );
    }
  });

  bullexWs.on("error", (err) => {
    console.error(`⚠️ [${clientSocket.id.substring(0, 8)}] Erro:`, err.message);
    clientSocket.emit("error", { message: err.message });
  });

  bullexWs.on("close", () => {
    console.warn(`🔴 [${clientSocket.id.substring(0, 8)}] Conexão encerrada`);

    // Limpar
    if (pingInterval) clearInterval(pingInterval);
    aggregator.clear();

    clientSocket.emit("disconnected");

    // Reconexão com limite
    if (reconnectAttempts < maxReconnectAttempts && clientSocket.connected) {
      reconnectAttempts++;
      console.log(
        `🔄 [${clientSocket.id.substring(0, 8)}] Reconexão ${reconnectAttempts}/${maxReconnectAttempts}...`
      );

      setTimeout(() => {
        connectToBullEx(ssid, clientSocket);
      }, 5000);
    } else if (reconnectAttempts >= maxReconnectAttempts) {
      console.error(`❌ [${clientSocket.id.substring(0, 8)}] Máx reconexões atingido`);
      clientSocket.emit("error", { message: "Falha de conexão permanente" });
    }
  });

  connections.set(clientSocket.id, {
    ws: bullexWs,
    aggregator: aggregator,
  });
}

// ====== SOCKET.IO: Conexão do Cliente ======
io.on("connection", (clientSocket) => {
  console.log(`✅ Cliente Lovable: ${clientSocket.id.substring(0, 8)}`);

  clientSocket.on("authenticate", ({ ssid }) => {
    if (!ssid) {
      console.warn(`⚠️ [${clientSocket.id.substring(0, 8)}] SSID não fornecido`);
      clientSocket.emit("error", { message: "SSID não fornecido" });
      return;
    }
    connectToBullEx(ssid, clientSocket);
  });

  // Proxy para envio de mensagens
  clientSocket.on("sendMessage", (data) => {
    const connection = connections.get(clientSocket.id);
    if (connection && connection.ws.readyState === WebSocket.OPEN) {
      const messageData = data.msg || data;
      console.log(`📤 [${clientSocket.id.substring(0, 8)}] ${messageData.name || "message"}`);
      connection.ws.send(JSON.stringify(messageData));
    } else {
      console.warn(`⚠️ [${clientSocket.id.substring(0, 8)}] WebSocket não conectado`);
      clientSocket.emit("error", { message: "WebSocket não conectado" });
    }
  });

  // Limpeza
  clientSocket.on("disconnect", () => {
    console.log(`❌ [${clientSocket.id.substring(0, 8)}] Desconectado`);
    const connection = connections.get(clientSocket.id);
    if (connection) {
      connection.ws.close();
      connection.aggregator.clear();
      connections.delete(clientSocket.id);
    }
  });
});

// ====== ENDPOINTS ======
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    activeConnections: connections.size,
    timestamp: new Date().toISOString(),
  });
});

app.get("/status", (req, res) => {
  const stats = {
    uptime: process.uptime(),
    activeConnections: connections.size,
    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
    rateLimit: RATE_LIMITS,
  };
  res.json(stats);
});

app.get("/", (req, res) => {
  res.json({
    message: "Proxy BullEx Otimizado v3",
    status: "ok",
    connections: connections.size,
  });
});
