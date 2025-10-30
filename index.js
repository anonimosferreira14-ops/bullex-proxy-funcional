import express from "express";
import { Server } from "socket.io";
import cors from "cors";
import WebSocket from "ws";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy BullEx ativo em 0.0.0.0:${PORT}`);
});

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

const connections = new Map();
const clientBalances = new Map(); // Armazena saldos por cliente

// ====== RATE LIMITING ======
const RATE_LIMITS = {
  "candle-generated": { interval: 500, maxEvents: 5 },
  "candles-generated": { interval: 500, maxEvents: 5 },
  "price-splitter.client-buyback-generated": { interval: 1000, maxEvents: 3 },
  "positions-state": { interval: 1000, maxEvents: 10 },
  "balance-changed": { interval: 500, maxEvents: 10 },
};

// ====== FUNÇÃO DE NORMALIZAÇÃO ======
function toCents(amount) {
  if (amount == null) return null;
  const num = typeof amount === "string" ? Number(amount) : amount;
  if (Number.isNaN(num)) return null;
  if (!Number.isInteger(num)) return Math.round(num * 100);
  if (num > 100000) return num; // já está em centavos
  return num * 100;
}

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
    if (["candle-generated", "candles-generated", "price-splitter.client-buyback-generated"].includes(eventName)) {
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

      if (!silentEvents.includes(event)) {
        console.log(`📨 [${shortId}] Evento: ${event}`);
      }

      // ====== TRATAMENTO DE EVENTOS ======

      // Autenticação
      if (event === "authenticated") {
        console.log(`🎯 [${shortId}] Autenticado com sucesso!`);
        clientSocket.emit("authenticated", data);

        // Solicita saldo inicial automaticamente
        setTimeout(() => {
          try {
            bullexWs.send(
              JSON.stringify({
                name: "sendMessage",
                msg: { name: "balances.get-balances", version: "1.0", body: {} },
              })
            );
            console.log(`💵 [${shortId}] Pedido de saldo inicial enviado à BullEx`);
          } catch (e) {
            console.warn(`⚠️ [${shortId}] Falha ao pedir saldo inicial: ${e.message}`);
          }
        }, 600);
        return;
      }

      if (event === "unauthorized") {
        console.warn(`🚫 [${shortId}] SSID inválido.`);
        clientSocket.emit("unauthorized", data);
        return;
      }

      // Ping/Pong
      if (event === "ping") {
        bullexWs.send(JSON.stringify({ name: "pong" }));
        return;
      }

      if (event === "pong" || event === "timeSync") {
        return;
      }

      // Front (handshake)
      if (event === "front") {
        console.log(`🔄 [${shortId}] Evento 'front' recebido`);
        clientSocket.emit("front", data);
        return;
      }

      // ====== CAPTURA DE SALDO ======
      if (event === "balance-changed" || event === "balances") {
        let balanceAmountRaw = null;
        let currency = "USD";
        let balanceId = null;

        if (event === "balance-changed") {
          balanceAmountRaw = data?.msg?.current_balance?.amount;
          currency = data?.msg?.current_balance?.currency || "USD";
          balanceId = data?.msg?.current_balance?.id;
        }

        if (event === "balances" && Array.isArray(data?.msg)) {
          const usd = data.msg.find((b) => b.currency === "USD") || data.msg[0];
          if (usd) {
            balanceAmountRaw = usd.amount;
            currency = usd.currency || "USD";
            balanceId = usd.id;
          }
        }

        const balanceAmount = toCents(balanceAmountRaw);

        if (balanceAmount != null) {
          console.log(`💰 [${shortId}] Saldo detectado: ${currency} $${(balanceAmount / 100).toFixed(2)}`);
          clientBalances.set(clientSocket.id, balanceAmount);

          clientSocket.emit("balance", {
            msg: { current_balance: { id: balanceId, amount: balanceAmount, currency } },
          });

          clientSocket.emit("balance-changed", data);
          clientSocket.emit("current-balance", {
            amount: balanceAmount,
            currency,
            timestamp: Date.now(),
          });
        }
        return;
      }

      // Posições
      if (event === "position-changed") {
        const status = data.msg?.status;
        const result = data.msg?.result;
        if (status === "closed") {
          console.log(`${result === "win" ? "✅" : "❌"} [${shortId}] ${result}`);
        }
        clientSocket.emit("position-changed", data);
        return;
      }

      // High-frequency events
      if (event === "candle-generated" || event === "candles-generated") {
        if (aggregator.aggregate("candle-generated", data)) {
          aggregator.sendAggregated(clientSocket, "candles", data);
        }
        return;
      }

      if (event === "price-splitter.client-buyback-generated") {
        if (aggregator.aggregate(event, data)) {
          aggregator.sendAggregated(clientSocket, "pressure", data);
        }
        return;
      }

      if (event === "positions-state") {
        if (aggregator.aggregate(event, data)) {
          aggregator.sendAggregated(clientSocket, "positions", data);
        }
        return;
      }

      // ====== REEMITIR TUDO MAIS ======
      console.log(`📤 [${shortId}] Reemitindo: ${event}`);
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
      console.log(`🔄 [${shortId}] Tentando reconexão ${reconnectAttempts}/${maxReconnectAttempts}...`);
      setTimeout(() => connectToBullEx(ssid, clientSocket), 4000);
    }
  });

  bullexWs.on("error", (err) => {
    console.error(`⚠️ [${shortId}] Erro: ${err.message}`);
    clientSocket.emit("error", { message: err.message });
  });

  connections.set(clientSocket.id, { ws: bullexWs, aggregator, ssid, createdAt: Date.now() });
}

// ====== SOCKET.IO ======
io.on("connection", (clientSocket) => {
  const shortId = clientSocket.id.substring(0, 8);
  console.log(`✅ Cliente conectado: ${shortId}`);

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
      console.log(`📤 [${shortId}] Reenviando: ${data.msg?.name || "message"}`);
      connection.ws.send(JSON.stringify(data.msg || data));
    } else {
      console.warn(`⚠️ [${shortId}] WebSocket não conectado`);
      clientSocket.emit("error", { message: "WebSocket não conectado" });
    }
  });

  clientSocket.on("get-balance", () => {
    const balance = clientBalances.get(clientSocket.id);
    if (balance !== undefined) {
      console.log(`💰 [${shortId}] Enviando saldo: $${(balance / 100).toFixed(2)}`);
      clientSocket.emit("balance", {
        msg: {
          current_balance: { amount: balance, currency: "USD" },
        },
      });
    }
  });

  clientSocket.on("disconnect", () => {
    const connection = connections.get(clientSocket.id);
    if (connection) {
      try {
        if (connection.ws.readyState === WebSocket.OPEN) connection.ws.close();
      } catch {}
      connection.aggregator.clear();
      connections.delete(clientSocket.id);
    }
    clientBalances.delete(clientSocket.id);
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
  res.json({ message: "Proxy BullEx Saldo Real ✅", status: "ok", connections: connections.size })
);
