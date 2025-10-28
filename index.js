// ==========================================
//  🔗 Proxy BullEx Funcional (Render/Node 18+)
// ==========================================

import express from "express";
import { Server } from "socket.io";
import cors from "cors";
import socketIOClient from "socket.io-client";

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
  console.log("✅ Cliente Lovable conectado:", clientSocket.id);

  // Evento enviado pelo Lovable ao conectar
  clientSocket.on("authenticate", ({ ssid }) => {
    console.log("🔐 Autenticando com BullEx...");

    // Conexão direta com o WebSocket oficial da BullEx
    const bullexSocket = socketIOClient("wss://ws.trade.bull-ex.com/socket.io", {
      transports: ["websocket"], // ⚠️ Apenas WebSocket, sem polling
      query: {
        EIO: 3,
        transport: "websocket",
        t: Date.now(),
      },
      reconnection: true,
      reconnectionDelay: 5000,
    });

    connections.set(clientSocket.id, bullexSocket);

    // Log quando conectar na BullEx
    bullexSocket.on("connect", () => {
      console.log("📡 Conectado à BullEx WebSocket");
      console.log("📍 Endpoint:", bullexSocket.io.uri);

      // Envia o evento de autenticação
      bullexSocket.emit("authenticate", {
        name: "authenticate",
        msg: { ssid, protocol: 4 },
      });
    });

    // Autenticado com sucesso
    bullexSocket.on("authenticated", (data) => {
      console.log("🎯 Autenticado na BullEx");
      clientSocket.emit("authenticated", data);
    });

    // Não autorizado
    bullexSocket.on("unauthorized", (data) => {
      console.error("❌ Não autorizado:", data);
      clientSocket.emit("unauthorized", data);
    });

    // Eventos da BullEx → Lovable
    bullexSocket.on("candles-generated", (data) =>
      clientSocket.emit("candles", data)
    );
    bullexSocket.on("positions-state", (data) =>
      clientSocket.emit("positions", data)
    );
    bullexSocket.on("balance-changed", (data) =>
      clientSocket.emit("balance", data)
    );

    // Desconexão da BullEx
    bullexSocket.on("disconnect", (reason) => {
      console.warn("🔴 Desconectado da BullEx:", reason);
      clientSocket.emit("disconnected");
    });

    // Erro interno da BullEx
    bullexSocket.on("error", (error) => {
      console.error("⚠️ Erro BullEx:", error.message);
      clientSocket.emit("error", { message: error.message });
    });
  });

  // Quando o cliente (Lovable) desconectar
  clientSocket.on("disconnect", () => {
    console.log("❌ Cliente Lovable desconectado:", clientSocket.id);
    const bull = connections.get(clientSocket.id);
    if (bull) {
      bull.disconnect();
      connections.delete(clientSocket.id);
    }
  });
});

// Endpoint simples para ver status
app.get("/", (req, res) => {
  res.json({ status: "ok", connections: connections.size });
});
