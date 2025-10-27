// ==========================================
//  🔗 Proxy BullEx Funcional (Render/Node 18+)
// ==========================================

import express from "express";
import { Server } from "socket.io";
import pkg from "socket.io-client";
import cors from "cors";

// Corrige import para CommonJS e ESM (Render usa Node 25)
const SocketIOClient = pkg.io ? pkg.io : pkg;

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy BullEx ativo e escutando em 0.0.0.0:${PORT}`);
});

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"]
});

const connections = new Map();

// ==========================================
//  🔁 Conexão do Lovable → BullEx
// ==========================================
io.on("connection", (clientSocket) => {
  console.log("✅ Cliente Lovable conectado:", clientSocket.id);

  clientSocket.on("authenticate", ({ ssid }) => {
    if (!ssid) {
      console.warn("❌ SSID ausente — conexão ignorada.");
      clientSocket.emit("unauthorized", { reason: "SSID ausente" });
      return;
    }

    console.log("🔐 Autenticando com BullEx...");

    const bullexSocket = SocketIOClient("https://ws.trade.bull-ex.com", {
      path: "/socket.io/",
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 4000,
    });

    connections.set(clientSocket.id, bullexSocket);

    bullexSocket.on("connect", () => {
      console.log("✅ Conectado à BullEx WebSocket");
      bullexSocket.emit("authenticate", { ssid, protocol: 4 });
    });

    bullexSocket.on("authenticated", (data) => {
      console.log("🎯 Autenticado na BullEx");
      clientSocket.emit("authenticated", data);
    });

    bullexSocket.on("unauthorized", (data) => {
      console.error("❌ Não autorizado:", data);
      clientSocket.emit("unauthorized", data);
    });

    // Eventos BullEx → Lovable
    bullexSocket.on("candles-generated", (data) => clientSocket.emit("candles", data));
    bullexSocket.on("positions-state", (data) => clientSocket.emit("positions", data));
    bullexSocket.on("balance-changed", (data) => clientSocket.emit("balance", data));

    bullexSocket.on("disconnect", (reason) => {
      console.warn("🔴 Desconectado da BullEx:", reason);
      clientSocket.emit("disconnected", reason);
    });

    bullexSocket.on("error", (error) => {
      console.error("⚠️ Erro BullEx:", error.message);
      clientSocket.emit("error", { message: error.message });
    });
  });

  // Cleanup quando cliente Lovable desconecta
  clientSocket.on("disconnect", () => {
    console.log("❌ Cliente Lovable desconectado:", clientSocket.id);
    const bull = connections.get(clientSocket.id);
    if (bull) {
      bull.disconnect();
      connections.delete(clientSocket.id);
    }
  });
});

// ==========================================
//  🩺 Rotas de monitoramento
// ==========================================
app.get("/health", (req, res) => {
  res.json({ status: "ok", connections: connections.size });
});

app.get("/", (req, res) => {
  res.json({ message: "Proxy BullEx ativo ✅", status: "ok" });
});
