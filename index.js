import express from "express";
import { Server } from "socket.io";
import { io as SocketIOClient } from "socket.io-client";
import cors from "cors";

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

io.on("connection", (clientSocket) => {
  console.log("✅ Cliente Lovable conectado:", clientSocket.id);

  clientSocket.on("authenticate", ({ ssid }) => {
    console.log("🔐 Autenticando com BullEx...");

    const bullexSocket = SocketIOClient("https://ws.trade.bull-ex.com", {
      path: "/socket.io/",
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 5000
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

    bullexSocket.on("candles-generated", (data) => clientSocket.emit("candles", data));
    bullexSocket.on("positions-state", (data) => clientSocket.emit("positions", data));
    bullexSocket.on("balance-changed", (data) => clientSocket.emit("balance", data));

    bullexSocket.on("disconnect", () => {
      console.warn("🔴 Desconectado da BullEx");
      clientSocket.emit("disconnected");
    });

    bullexSocket.on("error", (error) => {
      console.error("⚠️ Erro BullEx:", error.message);
      clientSocket.emit("error", { message: error.message });
    });
  });

  clientSocket.on("disconnect", () => {
    console.log("❌ Cliente Lovable desconectado:", clientSocket.id);
    const bull = connections.get(clientSocket.id);
    if (bull) {
      bull.disconnect();
      connections.delete(clientSocket.id);
    }
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", connections: connections.size });
});

app.get("/", (req, res) => {
  res.json({ message: "Proxy BullEx ativo", status: "ok" });
});
