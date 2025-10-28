import express from "express";
import { Server } from "socket.io";
import WebSocket from "ws";
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

  let bullexWs = null;

  clientSocket.on("authenticate", ({ ssid }) => {
    if (!ssid) return console.error("❌ SSID ausente!");

    console.log("🔐 Autenticando com BullEx via WebSocket...");
    bullexWs = new WebSocket("wss://ws.trade.bull-ex.com:443");

    bullexWs.on("open", () => {
      console.log("✅ Conectado à BullEx!");
      const authPayload = {
        name: "authenticate",
        msg: { ssid, protocol: 3 }
      };
      bullexWs.send(JSON.stringify(authPayload));
      console.log("📤 Autenticação enviada à BullEx");
    });

    bullexWs.on("message", (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.name === "authenticated") {
          console.log("🎯 Autenticado na BullEx!");
          clientSocket.emit("authenticated", data);
        } else if (data.name === "unauthorized") {
          console.log("❌ SSID inválido na BullEx");
          clientSocket.emit("unauthorized", data);
        } else {
          // Encaminha todas as outras mensagens
          clientSocket.emit(data.name || "message", data);
        }
      } catch (err) {
        console.error("⚠️ Erro parseando mensagem:", err.message);
      }
    });

    bullexWs.on("close", () => {
      console.warn("🔴 Conexão com BullEx encerrada");
      clientSocket.emit("disconnected");
    });

    bullexWs.on("error", (err) => {
      console.error("⚠️ Erro BullEx:", err.message);
      clientSocket.emit("error", { message: err.message });
    });

    // PING manual a cada 15s
    const pingInterval = setInterval(() => {
      if (bullexWs && bullexWs.readyState === WebSocket.OPEN) {
        bullexWs.send(JSON.stringify({ name: "ping" }));
      }
    }, 15000);

    connections.set(clientSocket.id, { ws: bullexWs, ping: pingInterval });
  });

  // Repassa mensagens do cliente para a BullEx
  clientSocket.on("sendMessage", (data) => {
    const conn = connections.get(clientSocket.id);
    if (conn?.ws?.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(data.msg || data));
    }
  });

  // Desconexão do cliente
  clientSocket.on("disconnect", () => {
    console.log("❌ Cliente Lovable desconectado:", clientSocket.id);
    const conn = connections.get(clientSocket.id);
    if (conn) {
      clearInterval(conn.ping);
      if (conn.ws) conn.ws.close();
      connections.delete(clientSocket.id);
    }
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", connections: connections.size });
});
