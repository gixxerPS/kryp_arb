/**
 * Binance Spot Executor Adapter (WebSocket, HMAC)
 * ===============================================
 *
 * Rolle im System
 * ---------------
 * Dieses Modul kapselt **alle Binance-spezifischen Executor-Funktionen**
 * für den Spot-Handel.
 *
 * Es ist die **einzige Stelle**, die:
 *   - private Binance WebSocket APIs nutzt
 *   - Orders platziert / verwaltet
 *   - User-State (Balances, Fills) von Binance entgegennimmt
 *
 * Authentifizierung (HMAC – aktuell)
 * ----------------------------------
 * Aktuell verwenden wir **HMAC-basierte API Keys**.
 *
 * Benötigte Environment Variablen:
 *
 *   BINANCE_API_KEY
 *   BINANCE_API_SECRET
 *
 * Signatur-Regeln (Binance WS API):
 * 1) Alle params OHNE `signature`
 * 2) Alphabetisch nach Key sortieren
 * 3) UTF-8 Payload: key=value&key2=value2
 * 4) HMAC-SHA256 mit API_SECRET
 * 5) Ergebnis als HEX-String → `signature`
 *
 * (RSA / Ed25519 werden bewusst nicht genutzt)
 *
 * Aktuelle Features (Phase 1)
 * ---------------------------
 * ✔ Einmaliger Balance-Snapshot beim Executor-Start
 *   - WS API: `account.status`
 *   - Liefert: free / locked pro Asset
 *   - Reduziert auf:
 *       * USDT
 *       * Base-Assets aktiver Symbolpaare
 *
 * Geplante Features (Phase 2)
 * ---------------------------
 *
 * 1) User Data Streams (WebSocket)
 *    - Account Updates (Balance Changes)
 *    - Execution Reports (Trades / Fills)
 *    - Order State Transitions
 *
 *    Ziel:
 *    - Lokalen Executor-State **event-basiert** pflegen
 *    - Kein periodisches Balance-Polling
 *
 * 2) Order Management
 *    - placeOrder (LIMIT / MARKET)
 *    - cancelOrder
 *    - optional: batchOrders
 *
 *    Anforderungen:
 *    - idempotente Client-Order-IDs
 *    - saubere Zuordnung zu Trade-Intents
 *    - deterministische Error-Behandlung
 *
 * 3) Exchange-interner State
 *    - openOrders
 *    - lastFillTs
 *    - pendingQty pro Symbol
 *
 *    → wird vom globalen Executor-State konsumiert,
 *      aber **hier gepflegt**
 *
 * Architektur-Leitlinien
 * ----------------------
 * - EIN WebSocket pro Zweck:
 *     * Control / Orders / account.status
 *     * User-Data-Stream
 *
 * - Backpressure-fähig:
 *     * WS reconnect
 *     * Sequenz-IDs / event ordering
 *
 * - Deterministisch:
 *     * gleiche Inputs → gleiche WS Requests
 */
'use strict';
const crypto = require('crypto');
const WebSocket = require('ws');

const { getLogger } = require('../../common/logger');
const log = getLogger('executor').child({ exchange: 'binance' });

const { createReconnectWS } = require('../../common/ws_reconnect');
const { getExState } = require('../../common/exchange_state');
const { WS_STATE } = require('../../common/constants');

function buildPayload(params) {
  return Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
}

function signHmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function makeSignedParams(extra = {}) {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !secret) throw new Error('Missing BINANCE_API_KEY or BINANCE_API_SECRET');

  const params = {
    ...extra,
    apiKey,
    timestamp: Date.now(),
    recvWindow: 15000,
  };

  const payload = buildPayload(params);
  const signature = signHmacHex(secret, payload);
  return { ...params, signature };
}

// --- Adapter factory (singleton-ish) ---

let mgr = null;
let wsRef = null; // current websocket instance from mgr.connect()

const pending = new Map(); // id -> { resolve, reject, tmr }

/**
 * @brief Send a WS-API request and await response by id.
 * 
 * @param {string} method - Binance WS-API Methodenname (z. B. `account.status`, `order.place`).
 * @param {Object} params - Bereits signierte Request-Parameter (inkl. `apiKey`, `timestamp`, `signature`).
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=10000]
 *   Applikationsseitiger Timeout in Millisekunden. Dient ausschließlich als
 *   Sicherheitsnetz, falls der Server nicht oder zu spät antwortet, und verhindert
 *   dauerhaft blockierende Promises. Hat keinen Bezug zu Binance- oder
 *   WebSocket-Timeouts.
 * @returns {Promise<Object>}
 *   Resolvt mit `result` der Binance-Response oder rejectet bei Timeout,
 *   Verbindungsabbruch oder Fehlerstatus.
 */
function sendReq(method, params, { timeoutMs = 10_000 } = {}) {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`binance ws not open (method=${method})`));
  }

  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const tmr = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`binance ws timeout method=${method} id=${id}`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, tmr });

    const msg = { id, method, params };
    wsRef.send(JSON.stringify(msg));
  });
}

function rejectAllPending(err) {
  for (const [id, p] of pending.entries()) {
    clearTimeout(p.tmr);
    p.reject(err);
    pending.delete(id);
  }
}

/**
 * init(): opens and maintains the WS connection (reconnect logic via createReconnectWS)
 * getStartupBalances(): performs account.status over the same WS
 *
 * Later:
 * - subscribeUserData()
 * - placeOrder()
 * - cancelOrder()
 */
let openResolve;
let openReject;
let openPromise;
async function init( cfg ) {
  if (mgr) return openPromise; 

  openPromise = new Promise((res, rej) => {
    openResolve = res;
    openReject = rej;
  });

  const exState = getExState();
  const url = process.env.BINANCE_WS_URL ?? 'wss://ws-api.binance.com:443/ws-api/v3';

  mgr = createReconnectWS({
    name: 'binance-ws-api',
    log,

    connect: () => {
      const ws = new WebSocket(url);
      wsRef = ws;
      return ws;
    },

    onOpen: async (ws) => {
      wsRef = ws;
      exState.onWsState('binance-ws-api', WS_STATE.OPEN);
      log.info({ url }, 'binance ws-api connected');
      openResolve();
    },

    onMessage: (msg) => {
      exState.onWsMessage('binance-ws-api');
      let parsed;
      try {
        parsed = JSON.parse(msg.toString());
      } catch (e) {
        log.error({ err: e }, 'binance ws-api message parse error');
        return;
      }

      // Correlated WS-API response (has id)
      if (parsed.id) {
        const p = pending.get(parsed.id);
        if (!p) return;

        clearTimeout(p.tmr);
        pending.delete(parsed.id);

        if (parsed.status !== 200) {
          p.reject(new Error(`binance ws-api error: ${JSON.stringify(parsed)}`));
        } else {
          p.resolve(parsed.result);
        }
        return;
      }

      // Later: user-stream / async events handling here
      // handler(parsed)
    },

    onReconnect: () => {
      exState.onWsReconnect('binance-ws-api');
    },

    onClose: ({ code, reason }) => {
      exState.onWsState('binance-ws-api', WS_STATE.CLOSED);
      wsRef = null;
      rejectAllPending(new Error(`binance ws closed code=${code} reason=${reason || ''}`));
      openReject?.(new Error('ws closed during init'));
    },

    onError: (err) => {
      exState.onWsError('binance-ws-api', err);
      openReject?.(err);
    },

    delayOverrideMs: ({ type, code, reason, err }) => {
      if (type === 'close' && code === 1006) return 1000;

      const r = (reason || '').toLowerCase();
      const e = (err?.message || '').toLowerCase();

      if (code === 1008 || r.includes('policy')) return 120_000;
      if (e.includes('429') || r.includes('rate')) return 90_000;
      if (code === 1013 || r.includes('try again later')) return 60_000;

      return null;
    },
  });

  mgr.start();
  return openPromise;
}

// One-shot snapshot using the persistent WS
async function getStartupBalances( cfg ) {
  const params = makeSignedParams({ omitZeroBalances: true });
  log.debug({params}, `REQ account.status`);
  const result = await sendReq(
    'account.status',
    params,
    { timeoutMs: 10_000 }
  );
  log.debug({result}, `RES account.status`);
  // [2026-02-08 09:36:14.859 +0100] DEBUG (executor): RES account.status
  //   exchange: "binance"
  //   result: {
  //     "makerCommission": 10,
  //     "takerCommission": 10,
  //     "buyerCommission": 0,
  //     "sellerCommission": 0,
  //     "commissionRates": {
  //       "maker": "0.00100000",
  //       "taker": "0.00100000",
  //       "buyer": "0.00000000",
  //       "seller": "0.00000000"
  //     },
  //     "canTrade": true,
  //     "canWithdraw": true,
  //     "canDeposit": true,
  //     "brokered": false,
  //     "requireSelfTradePrevention": false,
  //     "preventSor": false,
  //     "updateTime": 1770448831910, "timestamp": 1770539774592,
  //     "accountType": "SPOT",
  //     "balances": [
  //       {
  //         "asset": "BNB",
  //         "free": "0.17986778",
  //         "locked": "0.00000000"
  //       },
  //       {
  //         "asset": "USDC",
  //         "free": "292.71837548",
  //         "locked": "0.00000000"
  //       },
  //       {
  //         "asset": "EUR",
  //         "free": "150.18730214",
  //         "locked": "0.00000000"
  //       }
  //     ],
  //     "permissions": [
  //       "TRD_GRP_046"
  //     ],
  //     "uid": 1212042824
  //   }

  const map = new Map();
  for (const b of (result?.balances ?? [])) {
    map.set(b.asset, {
      free: Number(b.free ?? 0),
      locked: Number(b.locked ?? 0),
    });
  }

  const out = {};
  for (const a of assetsWanted) {
    const v = map.get(a) ?? { free: 0, locked: 0 };
    out[a] = { ...v, total: v.free + v.locked };
  }
  return out;
}

async function getAccountCommission(sym) {
  // convert "BTC_USDT" -> "BTCUSDT" (if you already have symToBinance(), use that)
  const symbol = sym;

  const params = makeSignedParams({ symbol });
  log.debug({ params }, `REQ account.commission ${symbol}`);

  const result = await sendReq('account.commission', params, { timeoutMs: 10_000 });

  log.debug({ result }, `RES account.commission ${symbol}`);

  // Typical fields (keep it tolerant; Binance may add/change fields):
  // - standardCommission: { maker, taker, buyer, seller }
  // - taxCommission: ...
  // - discount: { enabledForAccount, enabledForSymbol, discountAsset, discount }
  // - symbol: "BTCUSDT"
  const std = result?.standardCommission ?? result?.commissionRates ?? {};
  const discount = result?.discount ?? {};

  return {
    symbol: result?.symbol ?? symbol,
    standard: {
      maker: Number(std.maker ?? 0),
      taker: Number(std.taker ?? 0),
      buyer: Number(std.buyer ?? 0),
      seller: Number(std.seller ?? 0),
    },
    discount: {
      enabledForAccount: Boolean(discount.enabledForAccount),
      enabledForSymbol: Boolean(discount.enabledForSymbol),
      asset: discount.discountAsset ?? null,      // e.g. "BNB"
      rate: Number(discount.discount ?? 0),       // e.g. 0.25
    },
    raw: result, // optional: keep for debugging
  };
}

// Phase-2 stubs
async function subscribeUserData(/* handler */) {
  throw new Error('subscribeUserData not implemented');
}
async function placeOrder(/* order */) {
  throw new Error('placeOrder not implemented');
}
async function cancelOrder(/* id */) {
  throw new Error('cancelOrder not implemented');
}

module.exports = { 
  init,
  getStartupBalances,
  subscribeUserData,
  placeOrder,
  cancelOrder,
  getAccountCommission
};