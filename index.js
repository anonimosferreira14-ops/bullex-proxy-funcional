/**
 * Proxy BullEx - versão consolidada (FINAL)
 * - Login híbrido (email/senha ou SSID manual)
 * - Proxy WebSocket completo com candles, balances e posições
 * - Compatível com seu hook React e com o Lovable
 */

import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import WebSocket from "ws";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import cors from "cors";

/* =======================
   Configuração básica
======================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "*", // ajuste para seu domínio se quiser limitar
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 10000;
const BULL_EX_LOGIN = "https://trade.bull-ex.com/v2/login";
const BULL_EX_WS = "wss://ws.trade.bull-ex.com/echo/websocket";

/* =======================
   Rate Limiter
======================= */
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: "Muitas tentativas. Aguarde um minuto." },
});

/* =======================
   Helpers
======================= */
async function tryRestLogin(email, password, attempts = 3) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
    Origin: "https://trade.bull-ex.com",
    Referer: "https://trade.bull-ex.com/login",
  };

  const body = JSON.stringify({ email, password });

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(BULL_EX_LOGIN, {
        method: "POST",
        headers,
        body,
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }

      if (res.ok && json?.ssid) {
        return { success: true, ssid: json.ssid, raw: json };
      }

      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
        continue;
      }

      return { success: false, blocked: true, status: res.status, body: text };
    } catch (err) {
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
        continue;
      }
      return { success: false, error: err.message };
    }
  }
}

async function validateSsidViaWs(ssid, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BULL_EX_WS);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ valid: false, reason: "timeout" });
    }, timeoutMs);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          name: "authenticate",
          msg: { ssid, protocol: 3, client_session_id: "" },
        })
      );
    });

    ws.on("message", (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.name === "authenticated" && data.msg === true) {
          clearTimeout(timer);
          ws.terminate();
          resolve({ valid: true, info: data });
        }
      } catch {}
    });

    ws.on("error", () => {
      clearTimeout(timer);
      resolve({ valid: false, reason: "error" });
    });
  });
}

/* =======================
   Endpoint /auth/login
======================= */
app.post("/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password, ssid } = req.body;

    if (ssid) {
      const valid = await validateSsidViaWs(ssid);
      if (valid.valid)
        return res.json({ success: true, ssid, validated: true });
      return res
        .status(401)
        .json({ success: false, validated: false, message: "SSID inválido" });
    }

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "email e password ou ssid são necessários" });
    }

    const result = await tryRestLogin(email, password);

    if (result.success) return res.json({ success: true, ssid: result.ssid });

    return res.status(403).json({
      success: false,
      need_manual: true,
      message:
        "Autenticação via API REST bloqueada. Cole o SSID manualmente.",
    });
  } catch (err) {
    console.error("Erro /auth/login:", err);
    res.status(500).json({ success: false, message: "erro interno" });
  }
});

/* =======================
   Proxy WebSocket
======================= */
const clientUpstreams = new Map();

io.on("connection", (socket) => {
  console.log(`[SOCKET] conectado: ${socket.id}`);

  socket.on("authenticate", async ({ ssid }) => {
    if (!ssid) return socket.emit("auth_error", { message: "ssid necessário" });

    const valid = await validateSsidViaWs(ssid);
    if (!valid.valid)
      return socket.emit("auth_error", { message: "SSID inválido" });

    const upstream = new WebSocket(BULL_EX_WS);

    upstream.on("open", () => {
      upstream.send(
        JSON.stringify({
          name: "authenticate",
          msg: { ssid, protocol: 3, client_session_id: "" },
        })
      );
    });

    upstream.on("message", (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        parsed = data.toString();
      }
      socket.emit("bull_message", parsed);
    });

    upstream.on("close", () =>
      socket.emit("bull_closed", { reason: "BullEx desconectou" })
    );
    upstream.on("error", (err) =>
      socket.emit("bull_error", { message: err.message })
    );

    clientUpstreams.set(socket.id, upstream);
    socket.emit("auth_ok", { message: "autenticado no proxy" });
  });

  socket.on("bull_send", (payload) => {
    const upstream = clientUpstreams.get(socket.id);
    if (!upstream || upstream.readyState !== WebSocket.OPEN)
      return socket.emit("bull_error", { message: "upstream não conectado" });

    try {
      upstream.send(
        typeof payload === "string" ? payload : JSON.stringify(payload)
      );
    } catch (err) {
      socket.emit("bull_error", { message: err.message });
    }
  });

  socket.on("disconnect", () => {
    const upstream = clientUpstreams.get(socket.id);
    if (upstream) try { upstream.terminate(); } catch {}
    clientUpstreams.delete(socket.id);
    console.log(`[SOCKET] desconectado: ${socket.id}`);
  });
});

/* =======================
   Healthcheck
======================= */
app.get("/health", (req, res) =>
  res.json({ ok: true, connections: clientUpstreams.size })
);

/* =======================
   Start server
======================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy BullEx ativo na porta ${PORT}`);
  console.log(`Endpoints: /auth/login, /health`);
});
