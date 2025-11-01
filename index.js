/**
 * Proxy BullEx — Versão 3 (Corrigida com base nos logs reais)
 *
 * = Requisitos =
 * package.json deve incluir:
 * express, socket.io, ws, node-fetch, express-rate-limit, cors
 *
 * Deploy no Render: start = "node index.js"
 */

import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import WebSocket from "ws";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import cors from "cors";
import crypto from "crypto";

// ------------------- Config -------------------
const PORT = process.env.PORT || 10000;
const BULL_EX_LOGIN = "https://api.trade.bull-ex.com/v2/login";
const BULL_EX_WS = "wss://ws.trade.bull-ex.com/echo/websocket";
const app = express();

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

// ------------------- Helpers / Mappings -------------------

// =================================================================
// CORREÇÃO 1: ACTIVE_MAP atualizado com base nos seus logs [cite: 492-495, 514-521]
// =================================================================
const ACTIVE_MAP = {
  // Binários (OTC) - IDs de '1 Ativos underlying-list.txt'
  "EURUSD-OTC": 76,
  "EURGBP-OTC": 77,
  "USDCHF-OTC": 78,
  "EURJPY-OTC": 79,
  "GBPUSD-OTC": 81,
  "GBPJPY-OTC": 84,
  "USDJPY-OTC": 85,
  "AUDCAD-OTC": 86,
  "AUDUSD-OTC": 2111,
  "USDCAD-OTC": 2112,
  "AUDJPY-OTC": 2113,
  "EURCAD-OTC": 2117,
  "NZDUSD-OTC": 89, // (ID 89 não estava no seu log, mantendo do proxy anterior)
  "EURAUD-OTC": 2120,
  "GBPCHF-OTC": 2115,

  // Blitz (Digitais) - IDs do proxy anterior (você mencionou em prompts)
  "BTCUSD-BLZ": 201,
  "ETHUSD-BLZ": 202,
  "LTCUSD-BLZ": 203,
  "EURUSD-BLZ": 204,
  "GBPUSD-BLZ": 205,
  "USDJPY-BLZ": 206,
  "AUDUSD-BLZ": 207,
  "EURJPY-BLZ": 208,
  "USDCAD-BLZ": 209,
  "USDCHF-BLZ": 210,
};

// small in-memory stores
const connections = new Map(); // socketId -> { ws, aggregator, ssid, accountType, user_balance_id, currentActive }
const clientBalances = new Map(); // socketId -> amount (em CENTAVOS)
let globalRequestCounter = 1;

// utility: generate request_id similar to captured logs
function genRequestId() {
  const r = (Date.now() % 1e9) + "_" + globalRequestCounter++;
  return `${r}`;
}
function localTime() {
  return Math.floor(Date.now() % 1000000);
}
function toCentsMaybe(val) {
  if (val == null) return null;
  const n = Number(val);
  if (Number.isNaN(n)) return null;
  // Se já for um inteiro grande (provavelmente centavos), mantenha
  if (Number.isInteger(n) && n > 1000) return n;
  // Se for um float (dólares), converte para centavos
  return Math.round(n * 100);
}

// ------------------- Rate limiter -------------------
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: "Muitas tentativas. Aguarde 1 minuto." },
});

// ------------------- REST: try login and extract SSID -------------------
// (Esta função permanece a mesma, está correta)
async function tryRestLogin(email, password) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    Origin: "https://trade.bull-ex.com",
    Referer: "https://trade.bull-ex.com/login",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "x-platform-id": "189",
    "x-device-id": crypto.randomUUID(),
  };

  try {
    const res = await fetch(BULL_EX_LOGIN, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password }),
    });

    const text = await res.text();
    const rawHeaders = Object.fromEntries(res.headers.entries());
    const cookie = rawHeaders["set-cookie"] || rawHeaders["cookie"] || "";
    const ssid =
      cookie.match(/SSID=([^;]+)/)?.[1] ||
      text.match(/"ssid"\s*:\s*"([^"]+)"/i)?.[1] ||
      text.match(/"SSID"\s*:\s*"([^"]+)"/i)?.[1] ||
      null;

    return { ok: res.ok, status: res.status, ssid, rawBody: text, rawHeaders };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ------------------- Validate SSID via short WS handshake -------------------
// (Esta função permanece a mesma, está correta)
async function validateSsidViaWs(ssid, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BULL_EX_WS);
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          ws.terminate();
        } catch {}
        resolve({ valid: false, reason: "timeout" });
      }
    }, timeoutMs);

    ws.on("open", () => {
      try {
        ws.send(
          JSON.stringify({
            name: "authenticate",
            msg: { ssid, protocol: 3, client_session_id: "" },
          })
        );
      } catch (e) {}
    });

    ws.on("message", (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.name === "authenticated" && data.msg === true && !done) {
          done = true;
          clearTimeout(timer);
          try {
            ws.terminate();
          } catch {}
          resolve({ valid: true });
        } else if (data.name === "unauthorized" && !done) {
          done = true;
          clearTimeout(timer);
          try {
            ws.terminate();
          } catch {}
          resolve({ valid: false, reason: "unauthorized" });
        }
      } catch (e) {}
    });

    ws.on("error", (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ valid: false, reason: err.message });
      }
    });

    ws.on("close", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ valid: false, reason: "closed" });
      }
    });
  });
}

// ------------------- REST endpoints -------------------
// (Estas funções permanecem as mesmas, estão corretas)
app.get("/", (req, res) =>
  res.json({
    ok: true,
    message: "Proxy BullEx running",
    connections: connections.size,
  })
);
app.get("/health", (req, res) =>
  res.json({ ok: true, connections: connections.size, ts: Date.now() })
);

app.post("/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password, ssid } = req.body ?? {};

    if (ssid) {
      const valid = await validateSsidViaWs(ssid);
      if (valid.valid)
        return res.json({ success: true, ssid, validated: true });
      return res
        .status(401)
        .json({ success: false, validated: false, message: "SSID inválido" });
    }

    if (!email || !password)
      return res
        .status(400)
        .json({ success: false, message: "email/password or ssid required" });

    const result = await tryRestLogin(email, password);

    if (result.ssid) {
      const v = await validateSsidViaWs(result.ssid);
      if (v.valid) {
        return res.json({
          success: true,
          ssid: result.ssid,
          validated: true,
          raw: result,
        });
      } else {
        return res.json({
          success: false,
          ssid: result.ssid,
          validated: false,
          raw: result,
        });
      }
    }

    return res.status(403).json({
      success: false,
      message: "Autenticação via REST falhou. Cole o SSID manualmente.",
      details: {
        ok: result.ok,
        status: result.status,
        rawBodySample: (result.rawBody || "").slice(0, 400),
      },
    });
  } catch (err) {
    console.error("ERR /auth/login:", err);
    res.status(500).json({ success: false, error: err.message || "internal" });
  }
});

// ------------------- Aggregator utility -------------------
// (Esta função permanece a mesma, está correta)
class SimpleAggregator {
  constructor() {
    this.timers = {};
  }
  send(socket, event, data, delay = 80) {
    if (this.timers[event]) clearTimeout(this.timers[event]);
    this.timers[event] = setTimeout(() => {
      try {
        socket.emit(event, data);
      } catch (e) {}
    }, delay);
  }
  clear() {
    Object.values(this.timers).forEach(clearTimeout);
  }
}

// ------------------- Core: connectToBullEx per client -------------------
// (Funções de helper permanecem as mesmas)
function resolveActivePayload(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { type: "name", value: raw };
  if (typeof raw === "number") return { type: "id", value: raw };
  if (typeof raw === "object") {
    if (raw.active)
      return typeof raw.active === "number"
        ? { type: "id", value: raw.active }
        : { type: "name", value: raw.active };
    if (raw.name)
      return typeof raw.name === "number"
        ? { type: "id", value: raw.name }
        : { type: "name", value: raw.name };
    if (raw.msg && raw.msg.name) return { type: "name", value: raw.msg.name };
    if (raw.payload && typeof raw.payload === "string")
      return { type: "name", value: raw.payload };
  }
  return null;
}

function sendSubscribeCandles(bullexWs, id, timeframe = "1m") {
  try {
    const wrapper = {
      name: "sendMessage",
      msg: {
        name: "subscribe-candles",
        version: "1.0",
        body: { active_id: id, size: 60, at: timeframe },
      },
    };
    bullexWs.send(JSON.stringify(wrapper));
    bullexWs.send(
      JSON.stringify({
        name: "subscribe-candles",
        version: "1.0",
        body: { active_id: id, size: 60, at: timeframe },
      })
    );
  } catch (e) {}
}

function connectToBullEx(ssid, accountType, clientSocket) {
  const short = clientSocket.id.slice(0, 8);
  console.log(`[${short}] connecting to BullEx WS (Account: ${accountType})...`);
  const bullexWs = new WebSocket(BULL_EX_WS, {
    headers: {
      Origin: "https://trade.bull-ex.com",
      "User-Agent": "Mozilla/5.0",
    },
  });

  const aggregator = new SimpleAggregator();
  let pingInterval = null;
  let reconnectAttempts = 0;

  connections.set(clientSocket.id, {
    ws: bullexWs,
    aggregator,
    ssid,
    accountType,
    user_balance_id: null,
    currentActive: null,
  });

  bullexWs.on("open", () => {
    console.log(`[${short}] Bullex WS open, authenticating...`);
    reconnectAttempts = 0;
    try {
      // Autenticação (correta) [cite: 644, 676]
      bullexWs.send(
        JSON.stringify({
          name: "authenticate",
          msg: { ssid, protocol: 3, client_session_id: "" },
        })
      );
    } catch (e) {}

    pingInterval = setInterval(() => {
      if (bullexWs.readyState === WebSocket.OPEN)
        try {
          bullexWs.send(JSON.stringify({ name: "ping" }));
        } catch (e) {}
    }, 20000);

    // Após autenticar, pede os dados iniciais
    setTimeout(() => {
      try {
        // Pedido de saldo (correto) [cite: 672, 682]
        bullexWs.send(
          JSON.stringify({
            name: "sendMessage",
            msg: { name: "balances.get-balances", version: "1.0", body: {} },
          })
        );
        
        // =================================================================
        // CORREÇÃO 3: Adicionando subscrição de `balances.balance-changed` 
        // =================================================================
        bullexWs.send(
          JSON.stringify({
            name: "subscribeMessage",
            msg: { version: "1.0", name: "balances.balance-changed" },
            request_id: genRequestId(),
          })
        );
        
        // =================================================================
        // CORREÇÃO 4: Adicionando `frequency` ao `subscribe-positions` 
        // =================================================================
        bullexWs.send(
          JSON.stringify({
            name: "sendMessage",
            msg: { 
              name: "subscribe-positions", 
              version: "1.0", 
              body: { frequency: "frequent" } // Adicionado
            },
          })
        );

        bullexWs.send(
          JSON.stringify({
            name: "sendMessage",
            msg: { name: "actives.get-all", version: "1.0", body: {} },
          })
        );
        
        const defaultId = ACTIVE_MAP["EURUSD-OTC"];
        if (defaultId) sendSubscribeCandles(bullexWs, defaultId, "1m");
        
        console.log(
          `[${short}] Pedido de saldo, subscrição de saldo, positions, actives e candles enviados`
        );
      } catch (e) {}
    }, 600);
  });

  bullexWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const event = data.name || data.event || "unknown";
      if (!["ping", "pong", "timeSync"].includes(event))
        console.log(`[${short}] Evento: ${event}`);

      // AUTH events
      if (event === "authenticated") {
        clientSocket.emit("authenticated", data);
        // Não precisamos mais pedir saldo aqui, já é feito no open
        return;
      }
      if (event === "unauthorized") {
        clientSocket.emit("unauthorized", data);
        return;
      }

      // =================================================================
      // CORREÇÃO 2: Lógica de Saldo (Recebe DÓLARES, envia CENTAVOS)
      // =================================================================
      if (event === "balances" || event === "balance-changed") {
        const conn = connections.get(clientSocket.id);
        const requestedType = conn?.accountType || "real"; // 'real' ou 'demo'
        
        let targetBalance = null;
        let balancesArray = [];

        // 'balance-changed' tem um formato [cite: 646], 'balances' tem outro 
        if (event === "balance-changed") {
          if (data?.msg?.current_balance)
            balancesArray = [data.msg.current_balance];
        } else if (Array.isArray(data.msg)) {
          balancesArray = data.msg;
        }

        if (balancesArray.length > 0) {
          // Lógica para encontrar o saldo correto:
          // type: 1 = Real, type: 4 = Demo (Com base nos logs) 
          targetBalance = balancesArray.find(
            (b) =>
              (requestedType === "demo" && b.type === 4) ||
              (requestedType === "real" && b.type === 1)
          );

          // Fallback se a lógica de tipo falhar
          if (!targetBalance) {
            targetBalance =
              balancesArray.find((b) => b.currency === "USD") || balancesArray[0];
            console.warn(`[${short}] Não foi possível encontrar o saldo ${requestedType}. Usando fallback.`);
          }
        }
        
        if (targetBalance) {
          // 'amount' VEM COMO FLOAT (DÓLARES) ex: 72295.57 [cite: 682]
          const { amount, currency = "USD", id = null, user_balance_id = null } = targetBalance;
          const final_ubid = id || user_balance_id;

          // Converte para CENTAVOS para enviar ao cliente (Lovable)
          const amountInCents = Math.round(amount * 100);

          clientBalances.set(clientSocket.id, amountInCents); // Armazena em centavos
          if (conn) conn.user_balance_id = final_ubid || conn.user_balance_id;

          const balancePayload = {
            msg: {
              current_balance: {
                id: final_ubid,
                amount: amountInCents, // Envia CENTAVOS para o cliente
                currency,
                type: requestedType, 
              },
            },
          };

          clientSocket.emit("balance", balancePayload);
          clientSocket.emit("balance-changed", balancePayload);
          clientSocket.emit("current-balance", balancePayload);
          
          // Log corrigido para mostrar o valor em dólares
          console.log(
            `[${short}] Saldo detectado (${requestedType}): ${currency} ${amount.toFixed(2)}`
          );
        }
        return;
      }
      
      // (Restante das funções de encaminhamento de eventos permanecem as mesmas)

      // forward subscription / subscription events
      if (event === "subscription") {
        clientSocket.emit("subscription", data);
        return;
      }

      if (
        event === "price-splitter.client-buyback-generated" ||
        event === "client-buyback-generated"
      ) {
        clientSocket.emit("price-splitter.client-buyback-generated", data);
        clientSocket.emit("client-buyback-generated", data);
        return;
      }

      // positions-state / position-changed [cite: 660-662, 666]
      if (event === "positions-state") {
        clientSocket.emit("positions-state", data);
        return;
      }
      if (event === "position-changed") {
        clientSocket.emit("position-changed", data);
        const status = data?.msg?.status || data?.msg?.result || null;
        if (status) clientSocket.emit("order-result", data);
        return;
      }

      // candles [cite: 666]
      if (event === "candle-generated" || event === "candles-generated") {
        const m = data.msg || data;
        const normalized = {
          msg: {
            active_id:
              m.active_id || m.instrument_id || m.instrument || m.active,
            timeframe: m.size || m.timeframe || 60,
            open: m.open,
            close: m.close,
            high: m.max || m.high,
            low: m.min || m.low,
            from: m.from,
            to: m.to,
            volume: m.volume || 0,
            raw: data,
          },
        };
        aggregator.send(clientSocket, "candles", normalized, 80);
        return;
      }

      if (event === "result" && data.request_id) {
        clientSocket.emit("bull_result", data);
        const success = data?.msg?.success;
        if (typeof success !== "undefined") {
          clientSocket.emit("order-response", data);
        }
        return;
      }

      // default forward
      clientSocket.emit(event, data);
    } catch (err) {
      console.error(`[${short}] parse error: ${err.message}`);
    }
  });

  bullexWs.on("close", () => {
    console.warn(`[${short}] Bullex WS closed`);
    if (pingInterval) clearInterval(pingInterval);
    const conn = connections.get(clientSocket.id);
    if (conn) conn.aggregator.clear();
    clientBalances.delete(clientSocket.id);
    clientSocket.emit("disconnected");
    if (reconnectAttempts < 6) {
      reconnectAttempts++;
      console.log(`[${short}] reconnect attempt #${reconnectAttempts} in 4s`);
      setTimeout(() => {
        try {
          const currentConn = connections.get(clientSocket.id);
          if (currentConn) {
             connectToBullEx(ssid, currentConn.accountType, clientSocket);
          }
        } catch (e) {}
      }, 4000);
    }
  });

  bullexWs.on("error", (err) => {
    console.error(`[${short}] Bullex WS error: ${err.message || err}`);
    clientSocket.emit("error", { message: err.message || "ws_error" });
  });
}

// ------------------- Socket.IO server -------------------
io.on("connection", (socket) => {
  console.log(`✅ Cliente Socket.IO conectado: ${socket.id}`);
    socket.onAny((event, data) => {
    console.log(`[${socket.id.slice(0,8)}] 🔍 Evento recebido do cliente: ${event}`, data);
  });

  // authenticate (correto, recebe accountType)
  socket.on("authenticate", async ({ ssid, accountType }) => {
    if (!ssid)
      return socket.emit("auth_error", { message: "ssid necessário" });
    
    const type = accountType || "real"; 

    const prev = connections.get(socket.id);
    if (prev && prev.ws && prev.ws.readyState === WebSocket.OPEN) {
      try {
        prev.ws.close();
      } catch (e) {}
      prev.aggregator.clear();
      connections.delete(socket.id);
    }
    connectToBullEx(ssid, type, socket);
  });

  // subscribe-active (correto, usa o ACTIVE_MAP corrigido)
  socket.on("subscribe-active", (payload) => {
    const conn = connections.get(socket.id);
    if (!conn || !conn.ws)
      return socket.emit("error", { message: "not connected to bullEx" });
    const resolved = resolveActivePayload(payload);
    if (!resolved)
      return socket.emit("error", {
        message: "invalid subscribe-active payload",
      });

    let idToSubscribe = null;
    let textual = null;
    if (resolved.type === "id") idToSubscribe = resolved.value;
    else {
      textual = resolved.value;
      idToSubscribe = ACTIVE_MAP[textual]; // Usa o mapa corrigido
      if (!idToSubscribe)
        return socket.emit("error", {
          message: `Ativo desconhecido: ${textual}`,
        });
    }

    try {
      const prior = connections.get(socket.id)?.currentActive;
      if (prior && prior !== idToSubscribe) {
        try {
          conn.ws.send(
            JSON.stringify({
              name: "unsubscribe-candles",
              msg: { active_id: prior },
            })
          );
        } catch {}
        console.log(`[${socket.id.slice(0, 8)}] Unsubscribed active ${prior}`);
      }
      sendSubscribeCandles(conn.ws, idToSubscribe, "1m");
      if (connections.get(socket.id))
        connections.get(socket.id).currentActive = idToSubscribe;
      socket.emit("subscribed-active", [
        { name: textual || `id-${idToSubscribe}`, id: idToSubscribe },
      ]);
      console.log(
        `[${socket.id.slice(0, 8)}] Subscribed active ${idToSubscribe}`
      );
    } catch (e) {
      socket.emit("error", { message: "Falha ao enviar subscribe-candles" });
    }
  });

  // generic pass-through (correto)
  socket.on("sendMessage", (envelope) => {
    const conn = connections.get(socket.id);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN)
      return socket.emit("error", { message: "Bullex WS not connected" });
    const payload = envelope?.msg ? envelope.msg : envelope;
    try {
      conn.ws.send(JSON.stringify(payload));
      console.log(
        `[${socket.id.slice(0, 8)}] Reenviando -> ${payload.name || "message"}`
      );
    } catch (e) {
      socket.emit("error", { message: e.message });
    }
  });

  // open-position (correto, nome do evento e option_type_id default=3) [cite: 652]
  socket.on("open-position", async (order) => {
    const conn = connections.get(socket.id);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN)
      return socket.emit("order-error", { message: "upstream not connected" });

    try {
      const user_balance_id =
        conn.user_balance_id ||
        order.balance_id ||
        order.user_balance_id ||
        null;
      const active_id =
        order.active_id || order.assetId || conn.currentActive;
      const direction = (order.direction || "call").toLowerCase();
      
      // Usa o ID 3 como padrão, conforme solicitado [cite: 571, 652]
      const option_type_id = order.option_type_id || 3; 

      const expiration_size = order.expiration_size || order.duration || 60;
      const price = order.price || 10000;
      
      // Converte o valor de DÓLARES (do app) para CENTAVOS (para a BullEx) [cite: 652]
      const amountCents = toCentsMaybe(order.amount || order.value || 0);
      const value = order.value || (amountCents != null ? amountCents : 0);

      const envelope = {
        name: "sendMessage",
        request_id: genRequestId(),
        local_time: localTime(),
        msg: {
          name: "binary-options.open-option",
          version: "2.0",
          body: {
            user_balance_id,
            active_id,
            option_type_id,
            direction,
            expiration_size,
            expired: Math.floor(Date.now() / 1000) + expiration_size,
            price,
            profit_percent: order.profit_percent || order.profit || 88,
            refund_value: order.refund_value || 0,
            value, // Envia em centavos
          },
        },
      };

      console.log(
        `[${socket.id.slice(0, 8)}] 📤 Enviando ordem BullEx =>`,
        envelope.msg.body
      );
      conn.ws.send(JSON.stringify(envelope));

      const rid = envelope.request_id;
      const responseHandler = (data) => {
        try {
          if (data.request_id && data.request_id === rid) {
            const success = data?.msg?.success === true;
            if (success) {
              socket.emit("order-confirmed", { request_id: rid, raw: data });
            } else {
              socket.emit("order-error", { request_id: rid, raw: data });
            }
          }
        } catch (e) {}
      };

      const onResult = (res) => responseHandler(res);
      socket.on("bull_result", onResult);

      setTimeout(() => {
        socket.off("bull_result", onResult);
      }, 12000);

      socket.emit("order-sent", { request_id: rid, envelope });
    } catch (err) {
      console.error("Erro open-position:", err);
      socket.emit("order-error", {
        message: err.message || "open-position failed",
      });
    }
  });

  socket.on("get-balance", () => {
    // Retorna o saldo em CENTAVOS, como o cliente espera
    const b = clientBalances.get(socket.id);
    if (b !== undefined)
      socket.emit("balance", {
        msg: { current_balance: { amount: b, currency: "USD" } },
      });
    else
      socket.emit("balance", {
        msg: { current_balance: { amount: 0, currency: "USD" } },
      });
  });

  socket.on("disconnect", () => {
    const conn = connections.get(socket.id);
    if (conn && conn.ws) {
      try {
        conn.ws.close();
      } catch (e) {}
      conn.aggregator.clear();
    }
    connections.delete(socket.id);
    clientBalances.delete(socket.id);
    console.log(`❌ Cliente desconectado: ${socket.id}`);
  });
});

// ------------------- Start -------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy BullEx ativo na porta ${PORT}`);
  console.log(`🌐 Endpoints: /auth/login | /health`);
});
