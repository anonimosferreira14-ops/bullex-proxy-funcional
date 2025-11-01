/**
 * Proxy BullEx — Versão definitiva (funcional com Lovable)
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
// Active map (common OTC & BLITZ) - extend if needed
const ACTIVE_MAP = {
  "EURUSD-OTC": 76,
  "GBPUSD-OTC": 77,
  "USDJPY-OTC": 78,
  "AUDUSD-OTC": 79,
  "EURJPY-OTC": 80,
  "EURGBP-OTC": 81,
  "USDCHF-OTC": 82,
  "USDCAD-OTC": 83,
  "EURCAD-OTC": 84,
  "GBPJPY-OTC": 85,
  "GBPCHF-OTC": 86,
  "AUDJPY-OTC": 87,
  "AUDCAD-OTC": 88,
  "NZDUSD-OTC": 89,
  // Blitz examples
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
const clientBalances = new Map(); // socketId -> amount (raw cents or unit as coming)
let globalRequestCounter = 1;

// utility: generate request_id similar to captured logs
function genRequestId() {
  const r = (Date.now() % 1e9) + "_" + globalRequestCounter++;
  return `${r}`;
}
function localTime() {
  // matches logs where local_time is small int (client tick); use ms % 1e7
  return Math.floor(Date.now() % 1000000);
}
function toCentsMaybe(val) {
  if (val == null) return null;
  const n = Number(val);
  if (Number.isNaN(n)) return null;
  // If already large integer (likely cents) keep, else multiply
  if (Number.isInteger(n) && n > 1000) return n;
  // assume decimal units -> cents
  return Math.round(n * 100);
}

// ------------------- Rate limiter -------------------
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: "Muitas tentativas. Aguarde 1 minuto." },
});

// ------------------- REST: try login and extract SSID -------------------
async function tryRestLogin(email, password) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    Origin: "https://trade.bull-ex.com",
    Referer: "https://trade.bull-ex.com/login",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "x-platform-id": "189",
    // x-device-id can be random, BullEx sometimes expects it
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
    // try extract SSID from set-cookie or body
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

// test endpoint: validate ssid quickly
app.get("/test/ssid/:ssid", async (req, res) => {
  const { ssid } = req.params;
  if (!ssid) return res.status(400).json({ ok: false, error: "ssid required" });
  const valid = await validateSsidViaWs(ssid, 7000);
  return res.json(valid);
});

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

    // If BullEx returned ssid in headers/body even with 403/401, accept it
    if (result.ssid) {
      // double-check validity quickly
      const v = await validateSsidViaWs(result.ssid);
      if (v.valid) {
        return res.json({
          success: true,
          ssid: result.ssid,
          validated: true,
          raw: result,
        });
      } else {
        // still return it for manual fallback (client can try)
        return res.json({
          success: false,
          ssid: result.ssid,
          validated: false,
          raw: result,
        });
      }
    }

    // no ssid found: return details but not raw HTML
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
    // bullEx expects both wrapper and direct variants in some flows
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

// =================================================================
// CORREÇÃO 1: A função agora aceita `accountType`
// =================================================================
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

  // =================================================================
  // CORREÇÃO 1.1: Armazenando o `accountType` na conexão
  // =================================================================
  connections.set(clientSocket.id, {
    ws: bullexWs,
    aggregator,
    ssid,
    accountType, // Salva o tipo de conta
    user_balance_id: null,
    currentActive: null,
  });

  bullexWs.on("open", () => {
    console.log(`[${short}] Bullex WS open, authenticating...`);
    reconnectAttempts = 0;
    try {
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
        // after auth: ask balances, positions, actives, default candles
        setTimeout(() => {
          try {
            bullexWs.send(
              JSON.stringify({
                name: "sendMessage",
                msg: { name: "balances.get-balances", version: "1.0", body: {} },
              })
            );
            bullexWs.send(
              JSON.stringify({
                name: "sendMessage",
                msg: { name: "subscribe-positions", version: "1.0", body: {} },
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
              `[${short}] Pedido de saldo, positions, actives e candles enviados`
            );
          } catch (e) {}
        }, 600);
        return;
      }
      if (event === "unauthorized") {
        clientSocket.emit("unauthorized", data);
        return;
      }

      // =================================================================
      // CORREÇÃO 2: Lógica de Saldo (Real vs Demo)
      // =================================================================
      if (event === "balances" || event === "balance-changed") {
        const conn = connections.get(clientSocket.id);
        const requestedType = conn?.accountType || "real"; // 'real' ou 'demo'
        
        let targetBalance = null;
        let balancesArray = [];

        if (event === "balance-changed") {
          if (data?.msg?.current_balance)
            balancesArray = [data.msg.current_balance];
        } else if (Array.isArray(data.msg)) {
          balancesArray = data.msg;
        }

        if (balancesArray.length > 0) {
          // Lógica para encontrar o saldo correto:
          // Tipo 1 = Real, Tipo 4 = Demo (Padrão comum nessas plataformas)
          // Também checa 'is_demo' como fallback.
          targetBalance = balancesArray.find(
            (b) =>
              (requestedType === "demo" && (b.type === 4 || b.is_demo === true)) ||
              (requestedType === "real" && (b.type === 1 || b.is_demo === false || b.is_demo == null))
          );

          // Fallback se a lógica de tipo falhar: Tenta pegar o primeiro USD
          if (!targetBalance) {
            targetBalance =
              balancesArray.find((b) => b.currency === "USD") || balancesArray[0];
            console.warn(`[${short}] Não foi possível encontrar o saldo ${requestedType}. Usando fallback.`);
          }
        }
        
        if (targetBalance) {
          const { amount, currency = "USD", id = null, user_balance_id = null } = targetBalance;
          const final_ubid = id || user_balance_id;

          clientBalances.set(clientSocket.id, amount);
          if (conn) conn.user_balance_id = final_ubid || conn.user_balance_id;

          // Monta o payload de saldo que o cliente espera
          const balancePayload = {
            msg: {
              current_balance: {
                id: final_ubid,
                amount,
                currency,
                type: requestedType, // Envia o tipo de conta para o cliente
              },
            },
          };

          // Emite o saldo para todos os listeners do cliente
          clientSocket.emit("balance", balancePayload);
          clientSocket.emit("balance-changed", balancePayload);
          clientSocket.emit("current-balance", balancePayload);
          console.log(
            `[${short}] Saldo detectado (${requestedType}): ${currency} ${(
              amount / 100
            ).toFixed(2)}`
          );
        }
        return;
      }


      // forward subscription / subscription events
      if (event === "subscription") {
        clientSocket.emit("subscription", data);
        return;
      }

      // price-splitter / pressure events (client-buyback)
      if (
        event === "price-splitter.client-buyback-generated" ||
        event === "client-buyback-generated"
      ) {
        clientSocket.emit("price-splitter.client-buyback-generated", data);
        clientSocket.emit("client-buyback-generated", data);
        return;
      }

      // positions-state / position-changed
      if (event === "positions-state") {
        clientSocket.emit("positions-state", data);
        return;
      }
      if (event === "position-changed") {
        clientSocket.emit("position-changed", data);
        // if position closed, also forward explicit order result event
        const status = data?.msg?.status || data?.msg?.result || null;
        if (status) clientSocket.emit("order-result", data);
        return;
      }

      // candles -> normalize and forward as 'candles'
      if (event === "candle-generated" || event === "candles-generated") {
        // normalize shape expected by Lovable
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

      // result responses for specific request_id (order confirmations)
      if (event === "result" && data.request_id) {
        clientSocket.emit("bull_result", data);
        // if success true and request corresponds to open-option -> emit order-confirmed
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
    // try reconnect with exponential backoff (client will reauth if needed)
    if (reconnectAttempts < 6) {
      reconnectAttempts++;
      console.log(`[${short}] reconnect attempt #${reconnectAttempts} in 4s`);
      setTimeout(() => {
        try {
          // CORREÇÃO: Passa o accountType na reconexão
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

  // =================================================================
  // CORREÇÃO 1.2: Recebendo `ssid` E `accountType` do cliente
  // =================================================================
  socket.on("authenticate", async ({ ssid, accountType }) => {
    if (!ssid)
      return socket.emit("auth_error", { message: "ssid necessário" });
    
    // Define 'real' como padrão se o cliente não enviar o tipo
    const type = accountType || "real"; 

    // cleanup any previous
    const prev = connections.get(socket.id);
    if (prev && prev.ws && prev.ws.readyState === WebSocket.OPEN) {
      try {
        prev.ws.close();
      } catch (e) {}
      prev.aggregator.clear();
      connections.delete(socket.id);
    }
    // make connection
    connectToBullEx(ssid, type, socket);
  });

  // subscribe-active: when client requests an active, map and send subscribe-candles
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
      idToSubscribe = ACTIVE_MAP[textual];
      if (!idToSubscribe)
        return socket.emit("error", {
          message: `Ativo desconhecido: ${textual}`,
        });
    }

    try {
      // unsubscribe prior if different
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

  // generic pass-through for sendMessage envelope from client
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

  // =================================================================
  // CORREÇÃO 3: O nome do evento agora é 'open-position'
  // =================================================================
  socket.on("open-position", async (order) => {
    const conn = connections.get(socket.id);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN)
      return socket.emit("order-error", { message: "upstream not connected" });

    try {
      // normalize and build body exactly as BullEx expects
      const user_balance_id =
        conn.user_balance_id ||
        order.balance_id ||
        order.user_balance_id ||
        null;
      const active_id =
        order.active_id || order.assetId || conn.currentActive;
      const direction = (order.direction || "call").toLowerCase();
      
      // =================================================================
      // CORREÇÃO 4: `option_type_id` padrão agora é 3 (conforme prompt)
      // =================================================================
      const option_type_id = order.option_type_id || 3; // 

      const expiration_size = order.expiration_size || order.duration || 60;
      // price often a scale like 10000 in logs — keep default 10000 (BullEx expects integer scaled value)
      const price = order.price || 10000;
      // value is amount in cents or formatted per BullEx; accept amount in dollars or cents
      const amountCents = toCentsMaybe(order.amount || order.value || 0);
      // If amountCents null fallback to order.value or price
      const value = order.value || (amountCents != null ? amountCents : 0);

      // craft envelope wrapper expected by BullEx
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
            value, // value in cents (or as supplied)
          },
        },
      };

      console.log(
        `[${socket.id.slice(0, 8)}] 📤 Enviando ordem BullEx =>`,
        envelope
      );
      conn.ws.send(JSON.stringify(envelope));

      // listen for response matching this request_id within a short window
      const rid = envelope.request_id;
      const responseHandler = (data) => {
        try {
          if (data.request_id && data.request_id === rid) {
            // success or failure
            const success = data?.msg?.success === true;
            if (success) {
              socket.emit("order-confirmed", { request_id: rid, raw: data });
            } else {
              socket.emit("order-error", { request_id: rid, raw: data });
            }
          }
        } catch (e) {}
      };

      // attach temporary listener on socket to receive 'bull_result' forwarded earlier
      const onResult = (res) => responseHandler(res);
      socket.on("bull_result", onResult);

      // timeout cleanup
      setTimeout(() => {
        socket.off("bull_result", onResult);
      }, 12000);

      // respond ack immediately (client can wait for order-confirmed)
      socket.emit("order-sent", { request_id: rid, envelope });
    } catch (err) {
      console.error("Erro open-position:", err);
      socket.emit("order-error", {
        message: err.message || "open-position failed",
      });
    }
  });

  socket.on("get-balance", () => {
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
    // close underlying bullEx connection
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
  console.log(`🌐 Endpoints: /auth/login | /health | /test/ssid/:ssid`);
});
