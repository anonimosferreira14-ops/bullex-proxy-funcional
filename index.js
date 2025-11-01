/**
 * 🔧 Proxy BullEx — versão revisada e funcional
 * Corrige:
 *  - Login REST 401 (agora tenta extrair SSID do header e body)
 *  - Validação via WS (sem fechar antes da resposta)
 *  - Compatibilidade Lovable + hook React
 */

import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import WebSocket from "ws";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
const BULL_EX_LOGIN = "https://api.trade.bull-ex.com/v2/login";
const BULL_EX_WS = "wss://ws.trade.bull-ex.com/echo/websocket";

// =======================
// Rate limiter
// =======================
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: "Muitas tentativas, aguarde." },
});

// =======================
// Helper: tentativa de login
// =======================
async function tryRestLogin(email, password) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    Origin: "https://trade.bull-ex.com",
    Referer: "https://trade.bull-ex.com/login",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  };

  try {
    const res = await fetch(BULL_EX_LOGIN, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password }),
    });

    const body = await res.text();
    const rawHeaders = Object.fromEntries(res.headers.entries());

    // tenta extrair SSID do header ou body
    const cookie = rawHeaders["set-cookie"] || "";
    const ssid =
      cookie.match(/SSID=([^;]+)/)?.[1] ||
      body.match(/"ssid"\s*:\s*"([^"]+)"/i)?.[1] ||
      body.match(/"SSID"\s*:\s*"([^"]+)"/i)?.[1] ||
      null;

    if (ssid) {
      console.log("✅ SSID extraído:", ssid.slice(0, 8) + "...");
      return { success: true, ssid, body, headers: rawHeaders };
    }

    return {
      success: false,
      message: "Falha ao obter SSID",
      status: res.status,
      body,
    };
  } catch (err) {
    console.error("❌ Erro no tryRestLogin:", err.message);
    return { success: false, error: err.message };
  }
}

// =======================
// Helper: valida SSID via WebSocket
// =======================
async function validateSsidViaWs(ssid, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BULL_EX_WS);
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          ws.terminate();
        } catch {}
        resolve({ valid: false, reason: "timeout" });
      }
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
        if (data.name === "authenticated" && data.msg === true && !resolved) {
          resolved = true;
          clearTimeout(timer);
          ws.terminate();
          resolve({ valid: true });
        }
      } catch {}
    });

    ws.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ valid: false, reason: err.message });
      }
    });

    ws.on("close", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ valid: false, reason: "closed" });
      }
    });
  });
}

// =======================
// /auth/login
// =======================
app.post("/auth/login", authLimiter, async (req, res) => {
  const { email, password, ssid } = req.body;

  if (ssid) {
    const valid = await validateSsidViaWs(ssid);
    if (valid.valid) return res.json({ success: true, ssid, validated: true });
    return res
      .status(401)
      .json({ success: false, validated: false, message: "SSID inválido" });
  }

  if (!email || !password)
    return res
      .status(400)
      .json({ success: false, message: "Informe email e senha ou SSID." });

  const result = await tryRestLogin(email, password);
  if (result.success)
    return res.json({ success: true, ssid: result.ssid, validated: true });

  return res.status(403).json({
    success: false,
    message: "Login falhou. Cole SSID manualmente.",
    details: result,
  });
});

// =======================
// WebSocket Proxy
// =======================
const clientUpstreams = new Map();

io.on("connection", (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  socket.on("authenticate", async ({ ssid }) => {
    if (!ssid) return socket.emit("auth_error", { message: "SSID necessário" });

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
      socket.emit("auth_ok", { message: "Conectado à BullEx" });
    });

    upstream.on("message", (data) => {
      try {
        socket.emit("bull_message", JSON.parse(data.toString()));
      } catch {
        socket.emit("bull_message", data.toString());
      }
    });

    upstream.on("close", () =>
      socket.emit("bull_closed", { reason: "BullEx desconectou" })
    );
    upstream.on("error", (err) =>
      socket.emit("bull_error", { message: err.message })
    );

    clientUpstreams.set(socket.id, upstream);
  });

  socket.on("bull_send", (payload) => {
    const upstream = clientUpstreams.get(socket.id);
    if (!upstream || upstream.readyState !== WebSocket.OPEN)
      return socket.emit("bull_error", { message: "Upstream não conectado" });

    upstream.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  });

  socket.on("disconnect", () => {
    const upstream = clientUpstreams.get(socket.id);
    if (upstream) try { upstream.terminate(); } catch {}
    clientUpstreams.delete(socket.id);
    console.log(`❌ Cliente saiu: ${socket.id}`);
  });
});

// =======================
// /health
// =======================
app.get("/health", (req, res) =>
  res.json({ ok: true, clients: clientUpstreams.size, ts: Date.now() })
);

// =======================
// Start server
// =======================
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy BullEx ativo na porta ${PORT}`);
  console.log(`🌐 Endpoints: /auth/login | /health`);
});
