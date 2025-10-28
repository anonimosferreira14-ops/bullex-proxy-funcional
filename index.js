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

// Função auxiliar: reconexão
function connectToBullEx(ssid, clientSocket) {
  console.log("🔐 Autenticando com BullEx via WebSocket...");

  const bullexWs = new WebSocket("wss://ws.trade.bull-ex.com/echo/websocket");

  bullexWs.on("open", () => {
    console.log("✅ Conectado à BullEx via WebSocket. Enviando autenticação...");
    bullexWs.send(
      JSON.stringify({
        name: "authenticate",
        msg: { ssid, protocol: 3 },
      })
    );
  });

  bullexWs.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      const eventName = data.name || "unknown";

      switch (eventName) {
        case "authenticated":
          console.log("🎯 Autenticado com sucesso na BullEx!");
          clientSocket.emit("authenticated", data);
          break;

        case "unauthorized":
          console.warn("🚫 Autenticação negada na BullEx");
          clientSocket.emit("unauthorized", data);
          break;

        case "balance-changed":
          clientSocket.emit("balance", data);
          break;

        case "candles-generated":
          clientSocket.emit("candles", data);
          break;

        case "positions-state":
          clientSocket.emit("positions", data);
          break;

        case "position-changed":
          clientSocket.emit("position-changed", data);
          break;

        default:
          console.log("📡 Evento:", eventName);
          clientSocket.emit("event", data);
          break;
      }
    } catch (err) {
      console.error("⚠️ Erro ao parsear mensagem da BullEx:", err.message);
    }
  });

  bullexWs.on("error", (err) => {
    console.error("⚠️ Erro BullEx:", err.message);
    clientSocket.emit("error", { message: err.message });
  });

  bullexWs.on("close", () => {
    console.warn("🔴 Conexão com BullEx encerrada");
    clientSocket.emit("disconnected");

    // Tentativa de reconexão automática
    setTimeout(() => {
      if (clientSocket.connected) {
        console.log("♻️ Tentando reconexão com BullEx...");
        connectToBullEx(ssid, clientSocket);
      }
    }, 5000);
  });

  // Heartbeat a cada 20s para manter viva
  const pingInterval = setInterval(() => {
    if (bullexWs.readyState === WebSocket.OPEN) {
      bullexWs.send(JSON.stringify({ name: "ping" }));
    }
  }, 20000);

  bullexWs.on("close", () => clearInterval(pingInterval));

  connections.set(clientSocket.id, bullexWs);
}

// Evento de conexão Lovable
io.on("connection", (clientSocket) => {
  console.log("✅ Cliente Lovable conectado:", clientSocket.id);

  clientSocket.on("authenticate", ({ ssid }) => {
    if (!ssid) {
      console.warn("⚠️ Nenhum SSID recebido — abortando autenticação");
      return;
    }
    connectToBullEx(ssid, clientSocket);
  });

  // Proxy para envio de mensagens do cliente
  clientSocket.on("sendMessage", (data) => {
    const ws = connections.get(clientSocket.id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });

  // Limpeza ao desconectar
  clientSocket.on("disconnect", () => {
    console.log("❌ Cliente Lovable desconectado:", clientSocket.id);
    const ws = connections.get(clientSocket.id);
    if (ws) {
      ws.close();
      connections.delete(clientSocket.id);
    }
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", connections: connections.size });
});

app.get("/", (req, res) => {
  res.json({ message: "Proxy BullEx ativo", status: "ok" });
});
