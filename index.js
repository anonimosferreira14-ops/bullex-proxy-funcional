// ==========================================
// ✅ Proxy BullEx CORRIGIDO (Render/Node 18+)
// ==========================================

import express from "express";
import { Server } from "socket.io";
import cors from "cors";
import WebSocket from "ws";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 10000;

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy BullEx ativo na porta ${PORT}`);
});

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

const connections = new Map();

io.on("connection", (clientSocket) => {
  console.log("✅ Cliente conectado:", clientSocket.id);

  clientSocket.on("authenticate", ({ ssid }) => {
    console.log("🔐 Autenticando com BullEx...");
    console.log("📌 SSID recebido:", ssid);

    // ✅ CORREÇÃO 1: Usar WebSocket puro, não Socket.IO Client
    const bullexWs = new WebSocket("wss://ws.trade.bull-ex.com:443");

    let isAuthenticated = false;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;

    bullexWs.onopen = () => {
      console.log("📡 Conectado ao WebSocket BullEx");

      // ✅ CORREÇÃO 2: Enviar como JSON string, não como evento
      const authMessage = JSON.stringify({
        name: "authenticate",
        msg: {
          ssid: ssid,
          protocol: 3,
          session_id: "",
          client_session_id: "",
        },
      });

      console.log("📤 Enviando autenticação:", authMessage);
      bullexWs.send(authMessage);
    };

    bullexWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log("📨 Mensagem BullEx:", data.name);

        // ✅ CORREÇÃO 3: Emitir eventos corretos para o cliente
        if (data.name === "authenticated") {
          console.log("✅ AUTENTICADO NA BULLEX!");
          isAuthenticated = true;
          reconnectAttempts = 0;
          clientSocket.emit("authenticated", data);
        } else if (data.name === "unauthorized") {
          console.error("❌ SSID inválido ou expirado!");
          clientSocket.emit("unauthorized", data);
          bullexWs.close();
        } else if (data.name === "ping") {
          // ✅ CORREÇÃO 4: Responder a ping automaticamente
          bullexWs.send(JSON.stringify({ name: "pong" }));
        } else if (data.name === "balance-changed") {
          clientSocket.emit("balance", data);
        } else if (data.name === "position-changed") {
          clientSocket.emit("position", data);
        } else if (data.name === "candles-generated") {
          clientSocket.emit("candles", data);
        } else if (data.name === "price-splitter.client-buyback-generated") {
          clientSocket.emit("pressure", data);
        } else {
          // Emitir outros eventos genéricos
          clientSocket.emit("event", data);
        }
      } catch (err) {
        console.warn("⚠️ Erro ao parsear mensagem BullEx:", err.message);
      }
    };

    bullexWs.onerror = (error) => {
      console.error("❌ Erro WebSocket BullEx:", error.message);
      clientSocket.emit("error", { message: error.message });
    };

    bullexWs.onclose = (code, reason) => {
      console.warn(`🔴 Desconectado da BullEx. Código: ${code}, Razão: ${reason}`);

      if (!isAuthenticated && reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        console.log(`🔄 Tentativa de reconexão ${reconnectAttempts}/${maxReconnectAttempts}...`);
        setTimeout(() => {
          const newWs = new WebSocket("wss://ws.trade.bull-ex.com:443");
          bullexWs.onopen = newWs.onopen;
          bullexWs.onmessage = newWs.onmessage;
          bullexWs.onerror = newWs.onerror;
          bullexWs.onclose = newWs.onclose;
        }, 5000);
      }

      clientSocket.emit("disconnected", { code, reason });
    };

    // ✅ CORREÇÃO 5: Armazenar conexão para fechar depois
    connections.set(clientSocket.id, bullexWs);
  });

  // ✅ CORREÇÃO 6: Proxy de mensagens enviadas pelo cliente
  clientSocket.on("sendMessage", (data) => {
    const bullexWs = connections.get(clientSocket.id);
    if (bullexWs && bullexWs.readyState === WebSocket.OPEN) {
      console.log("📤 Reenviando mensagem para BullEx:", data.msg?.name);
      bullexWs.send(JSON.stringify(data.msg || data));
    } else {
      console.warn("⚠️ WebSocket não está aberto");
      clientSocket.emit("error", { message: "WebSocket não conectado" });
    }
  });

  // ✅ CORREÇÃO 7: Limpar conexão ao desconectar
  clientSocket.on("disconnect", () => {
    console.log("❌ Cliente desconectado:", clientSocket.id);
    const bullexWs = connections.get(clientSocket.id);
    if (bullexWs) {
      bullexWs.close();
      connections.delete(clientSocket.id);
    }
  });
});

// Endpoint de status
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    activeConnections: connections.size,
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

export default app;
