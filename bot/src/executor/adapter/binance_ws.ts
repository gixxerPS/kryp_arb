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
import crypto from 'crypto';
import WebSocket from 'ws';
import fs from 'fs';

import { getLogger } from '../../common/logger';
const log = getLogger('executor').child({ exchange: 'binance' });

import { createReconnectWS } from '../../common/ws_reconnect';
import { getExState } from '../../common/exchange_state';
import { WS_STATE } from '../../common/constants';

import type { 
  Balances, 
  CommonOrderResult, 
  PlaceOrderParams, 
  CancelOrderParams,
  PendingEntry } from '../../types/executor_adapter';
import type { AppConfig } from '../../types/config';
import type { WsParams, ExchangeId } from '../../types/common';

type BinanceBalance = { asset: string; free: string; locked: string };

type BinanceAccountStatusResult = {
  timestamp?: number;
  updateTime?: number;
  balances?: BinanceBalance[];
};

type BinanceOrderFill = {
  price: string;
  qty: string;
  commission?: string;
  commissionAsset?: string;
  tradeId?: number | string;
};

type BinancePlaceOrderResult = {
  symbol: string;
  orderId?: number;
  clientOrderId?: string;
  transactTime?: number;
  price?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  status?: string;
  fills?: BinanceOrderFill[];
};

type BinanceCancelOrderResult = {
  symbol: string;
  orderId?: number;
  clientOrderId?: string;
  origClientOrderId?: string;
  status?: string;
};

type SignedParams = WsParams & {
  apiKey: string;
  timestamp: number;
  recvWindow: number;
  signature: string;
};

type ReconnectDelayOverrideArgs = {
  type: 'close' | 'error';
  code?: number;
  reason?: string | Buffer;
  err?: Error;
};

type BinanceAccountCommissionResult = {
  symbol: string;

  standardCommission?: {
    maker?: string;
    taker?: string;
    buyer?: string;
    seller?: string;
  };

  commissionRates?: {
    maker?: string;
    taker?: string;
    buyer?: string;
    seller?: string;
  };

  discount?: {
    enabledForAccount?: boolean;
    enabledForSymbol?: boolean;
    discountAsset?: string;
    discount?: string;
  };
}

function buildPayload(params: Record<string, string | number | boolean | undefined | null>): string {
  return Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
}

function signEd25519Base64(privateKeyPem: string, payload: string): string {
  const sig = crypto.sign(
    null,                       // Ed25519 => algorithm = null
    Buffer.from(payload),       // payload = query string
    privateKeyPem
  );
  return sig.toString('base64'); // Binance verlangt base64
}

function makeSignedParams(extra: WsParams = {}): SignedParams {
  const apiKey = process.env.BINANCE_ED25519_PUBLIC_KEY;
  if (!apiKey) throw new Error('Missing BINANCE_ED25519_PUBLIC_KEY');

  const params = {
    ...extra,
    apiKey,
    timestamp: Date.now(),
    recvWindow: 15000,
  };

  const payload = buildPayload(params);
  // const signature = signHmacHex(secret, payload); -> OLD, binance recommends Ed25519
  const signature = signEd25519Base64(ed25519PrivateKeyPem, payload);
  return { ...params, signature };
}

// --- Adapter factory (singleton-ish) ---

let mgr : ReturnType<typeof createReconnectWS> | null = null;
let wsRef : WebSocket | null = null; // current websocket instance from mgr.connect()
let ed25519PrivateKeyPem : string  = '';     // string
const pending: Map<string, PendingEntry> = new Map(); // id -> { resolve, reject, tmr }

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
function sendReq<T>(method: string, params: Record<string, unknown>, 
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<T> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`binance ws not open (method=${method})`));
  }
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const tmr = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`binance ws timeout method=${method} id=${id}`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, tmr });

    try {
      wsRef?.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      clearTimeout(tmr);
      pending.delete(id);
      reject(e);
    }
  });
}

function rejectAllPending(err: unknown): void {
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
let openResolve: (() => void) | null = null;
let openReject: ((err: unknown) => void) | null = null;
let openPromise: Promise<void> | undefined;

async function init(cfg: AppConfig): Promise<void> {
  if (openPromise) return openPromise; 

  if (!process.env.BINANCE_ED25519_PRIVATE_KEY_FILE) {
    throw new Error('Binance Ed25519 credentials missing in .env');
  }
  ed25519PrivateKeyPem = fs.readFileSync(
    process.env.BINANCE_ED25519_PRIVATE_KEY_FILE,
    'utf8'
  );

  openPromise = new Promise<void>((res, rej) => {
    openResolve = res;
    openReject = rej;
  });

  const exState = getExState();
  const url = process.env.BINANCE_WS_URL ?? 'wss://ws-api.binance.com:443/ws-api/v3';

  mgr = createReconnectWS({
    name: 'binance-ws-api',
    log,
    staleTimeoutMs : null, // executor bekommt keine regelmaessigen nachrichten sondern ist in lauerstellung

    connect: () => {
      const ws = new WebSocket(url);
      wsRef = ws;
      return ws;
    },

    onOpen: async (ws: WebSocket) => {
      wsRef = ws;
      exState.onWsState('binance-ws-api', WS_STATE.OPEN);
      log.debug({ url }, 'binance ws-api connected');
      if (openResolve) {
        openResolve();
        openResolve = null;
        openReject = null;
      }
    },

    onMessage: (msg: Buffer) => {
      exState.onWsMessage('binance-ws-api');
      let parsed: any;
      try {
        parsed = JSON.parse(msg.toString());
        log.debug({msg:parsed}, 'onMessage');
      } catch (e) {
        log.error({ err: e }, 'binance ws-api message parse error');
        return;
      }

      if (!parsed?.id) return;
      // Correlated WS-API response (has id)
      const p = pending.get(parsed.id);
      if (!p) return;

      clearTimeout(p.tmr);
      pending.delete(parsed.id);

      if (parsed.status !== 200) {
        p.reject(new Error(`binance ws-api error: ${JSON.stringify(parsed)}`));
      } else {
        p.resolve(parsed.result);
      }

      // Later: user-stream / async events handling here
      // handler(parsed)
    },

    onReconnect: () => {
      exState.onWsReconnect('binance-ws-api');
    },

    onClose: ( code: number, reason: Buffer ) => {
      exState.onWsState('binance-ws-api', WS_STATE.CLOSED);
      // log.warn({code, reason}, 'ws closed');
      wsRef = null;
      rejectAllPending(new Error(`binance ws closed code=${code} reason=${reason || ''}`));
      openReject?.(new Error('ws closed during init'));
    },

    onError: (err: Error) => {
      exState.onWsError('binance-ws-api', err);
      openReject?.(err);
    },

    delayOverrideMs: ({ type, code, reason, err }: ReconnectDelayOverrideArgs): number | null => {
      if (type === 'close' && code === 1006) return 1000;

      const r = (reason || '');
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

/**
 * One-shot snapshot using the persistent WS
 * 
 * @param {object} cfg 
 * @returns {object} - {BNB:0.177, USDC:1234, ...}
 */
  // log.debug({result}, `RES account.status`);
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
export async function getStartupBalances(): Promise<Balances> {
  const params = makeSignedParams({ omitZeroBalances: true });

  const result = await sendReq<BinanceAccountStatusResult>('account.status', params, { timeoutMs: 10_000 });

  const out: Balances = {};
  for (const b of result?.balances ?? []) out[b.asset] = Number(b.free ?? 0);
  return out;
}

// test um zu pruefen ob rabatte auch wirklich hinterlegt sind
async function getAccountCommission(sym : string) {
  // convert "BTC_USDT" -> "BTCUSDT" (if you already have symToBinance(), use that)
  const symbol = sym;

  const params = makeSignedParams({ symbol });
  log.debug({ params }, `REQ account.commission ${symbol}`);

  const result = await sendReq<BinanceAccountCommissionResult>('account.commission', params, { timeoutMs: 10_000 });
  //[2026-02-08 09:46:31.758 +0100] DEBUG (executor): RES account.commission AXSUSDC exchange: "binance" result: 
  // { "symbol": "AXSUSDC", 
  //   "standardCommission": 
  //     { "maker": "0.00100000", "taker": "0.00095000", "buyer": "0.00000000", "seller": "0.00000000" }, 
  //   "specialCommission": 
  //     { "maker": "0.00000000", "taker": "0.00000000", "buyer": "0.00000000", "seller": "0.00000000" }, 
  //   "taxCommission": 
  //     { "maker": "0.00000000", "taker": "0.00000000", "buyer": "0.00000000", "seller": "0.00000000" }, 
  //   "discount": { "enabledForAccount": true, "enabledForSymbol": true, "discountAsset": "BNB", "discount": "0.75000000" } }
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


export async function placeOrder(test: boolean, orderParams: PlaceOrderParams): Promise<CommonOrderResult> {
  if (test) {
    log.debug({}, 'TEST ORDER!!!!');
  } else {
    log.debug({}, 'REAL ORDER!!!!');
  }
  // const method = test ? 'order.test' : 'order.place';
  const method = 'order.test';
  
  const params = makeSignedParams({
    symbol: orderParams.symbol,
    side: orderParams.side,
    type: orderParams.type,
    quantity: orderParams.quantity,
    price: orderParams.price,
    newClientOrderId: orderParams.orderId ? String(orderParams.orderId) : undefined,
    computeCommissionRates: true
  });

  const r = await sendReq<BinancePlaceOrderResult>(method, params, { timeoutMs: 10_000 });


  // beispielantwort von binance api:
  //   FULL response type:
  // {
  //     "id": "56374a46-3061-486b-a311-99ee972eb648",
  //     "status": 200,
  //     "result": {
  //         "symbol": "BTCUSDT",
  //         "orderId": 12569099453,
  //         "orderListId": -1,
  //         "clientOrderId": "4d96324ff9d44481926157ec08158a40",
  //         "transactTime": 1660801715793,
  //         "price": "23416.10000000",
  //         "origQty": "0.00847000",
  //         "executedQty": "0.00847000",
  //         "origQuoteOrderQty": "0.000000",
  //         "cummulativeQuoteQty": "198.33521500",
  //         "status": "FILLED",
  //         "timeInForce": "GTC",
  //         "type": "LIMIT",
  //         "side": "SELL",
  //         "workingTime": 1660801715793,
  //         // FULL response is identical to RESULT response, with the same optional fields
  //         // based on the order type and parameters. FULL response additionally includes
  //         // the list of trades which immediately filled the order.
  //         "fills": [
  //             {
  //                 "price": "23416.10000000",
  //                 "qty": "0.00635000",
  //                 "commission": "0.000000",
  //                 "commissionAsset": "BNB",
  //                 "tradeId": 1650422481
  //             },
  //             {
  //                 "price": "23416.50000000",
  //                 "qty": "0.00212000",
  //                 "commission": "0.000000",
  //                 "commissionAsset": "BNB",
  //                 "tradeId": 1650422482
  //             }
  //         ]
  //     },
  //     "rateLimits": [
  //         {
  //             "rateLimitType": "ORDERS",
  //             "interval": "SECOND",
  //             "intervalNum": 10,
  //             "limit": 50,
  //             "count": 1
  //         },
  //         {
  //             "rateLimitType": "ORDERS",
  //             "interval": "DAY",
  //             "intervalNum": 1,
  //             "limit": 160000,
  //             "count": 1
  //         },
  //         {
  //             "rateLimitType": "REQUEST_WEIGHT",
  //             "interval": "MINUTE",
  //             "intervalNum": 1,
  //             "limit": 6000,
  //             "count": 1
  //         }
  //     ]
  // }
  const out : CommonOrderResult = {
    exchange: 'binance',
    symbol: r.symbol,
    status: r.status,
    orderId: r.orderId,
    clientOrderId: r.clientOrderId,
    transactTime: r.transactTime,
    executedQty: r.executedQty,
    cummulativeQuoteQty: r.cummulativeQuoteQty,
    price: r.price,
    fills: r.fills,
  };
  return out;
}

export async function cancelOrder(p: CancelOrderParams): Promise<CommonOrderResult> {
  const params = makeSignedParams({
    symbol: p.symbol,
    origClientOrderId: p.origClientOrderId,
    orderId: p.orderId
  });

  const r = await sendReq<BinanceCancelOrderResult>('order.cancel', params, { timeoutMs: 10_000 });

  return {
    exchange: 'binance',
    symbol: r.symbol,
    status: r.status,
    orderId: r.orderId,
    clientOrderId: r.clientOrderId ?? r.origClientOrderId,
  };
}

module.exports = { 
  init,
  getStartupBalances,
  subscribeUserData,
  placeOrder,
  cancelOrder,
  getAccountCommission
};