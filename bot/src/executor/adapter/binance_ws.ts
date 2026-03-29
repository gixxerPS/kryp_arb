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
 * Authentifizierung (ED25519 – aktuell)
 *
 * Signatur-Regeln (Binance WS API):
 * 1) Alle params OHNE `signature`
 * 2) Alphabetisch nach Key sortieren
 * 3) UTF-8 Payload: key=value&key2=value2
 * 4) ED25519-SHA256 mit API_SECRET
 * 5) Ergebnis als HEX-String → `signature`
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
import crypto from 'crypto';
import WebSocket from 'ws';
import fs from 'fs';

import { getLogger } from '../../common/logger';
const log = getLogger('executor').child({ exchange: 'binance' });

import { createReconnectWS } from '../../common/ws_reconnect';
import { getExState } from '../../common/exchange_state';
import { WS_STATE } from '../../common/constants';
import { getCanonFromOderSym } from '../../common/symbolinfo';
import { getEx } from '../../common/symbolinfo';
import { getAssetPrice } from '../../common/symbolinfo_price';
import appBus from '../../bus';
import { OrderSides, ExchangeIds  } from '../../types/common';

import { 
  type Balances, 
  type CommonOrderResult, 
  type PlaceOrderParams, 
  type CancelOrderParams,
  type UpdateBalancesParams,
  type PendingEntry, 
  type ExecutorAdapter,
  OrderStates} from '../../types/executor';
import type { AppConfig } from '../../types/config';
import type { WsParams } from '../../types/common';
import type { ReconnectDelayOverrideArgs } from '../../types/ws_reconnect';

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
  orderId: number;
  clientOrderId: string;
  transactTime: number;
  price: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string;
  fills?: BinanceOrderFill[];
};

type BinanceCancelOrderResult = {
  symbol: string;
  orderId: number;
  clientOrderId?: string;
  origClientOrderId: string;
  transactTime: number;
  status: string;
};

type SignedParams = WsParams & {
  apiKey: string;
  timestamp: number;
  recvWindow: number;
  signature: string;
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

type BinanceUserDataSubscribeResult = {
  subscriptionId?: number;
};

type BinanceUserDataBalance = {
  a?: string;
  f?: string;
  l?: string;
};

type BinanceUserDataEvent = {
  e?: string;
  E?: number;
  B?: BinanceUserDataBalance[];
  s?: string;
  c?: string;
  S?: 'BUY' | 'SELL' | string;
  X?: string;
  i?: number | string;
  T?: number;
  z?: string;
  Z?: string;
  L?: string;
  n?: string;
  N?: string | null;
};

type BinanceUserDataMessage = {
  subscriptionId?: number;
  event?: BinanceUserDataEvent;
};

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

function makeSessionParams(extra: WsParams = {}): WsParams & { timestamp: number; recvWindow: number } {
  return {
    ...extra,
    timestamp: Date.now(),
    recvWindow: 15000,
  };
}

// --- Adapter factory (singleton-ish) ---

let mgr : ReturnType<typeof createReconnectWS> | null = null;
let wsRef : WebSocket | null = null; // current websocket instance from mgr.connect()
let ed25519PrivateKeyPem : string  = '';     // string
let busRef: any;
const pending: Map<string, PendingEntry> = new Map(); // id -> { resolve, reject, tmr }
let balances: Balances = {};
let balancesLoaded = false;
let isLoggedIn = false;
let userDataSubscriptionId: number | null = null;
const BALANCE_REFRESH_MS = 15 * 60 * 1000; // [ms] 15 min

function makeWsApiError(message: string, context: Record<string, unknown>): Error {
  const err = new Error(message) as Error & { context?: Record<string, unknown> };
  err.context = context;
  return err;
}

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
      reject(makeWsApiError(`binance ws timeout method=${method} id=${id}`, {
        id,
        method,
        params,
      }));
    }, timeoutMs);

    pending.set(id, {
      resolve,
      reject,
      tmr,
      requestContext: { method, params },
    });

    try {
      wsRef?.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      clearTimeout(tmr);
      pending.delete(id);
      log.error({ err: e, id, method, params }, 'binance ws-api send failed');
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

async function loginWs(): Promise<void> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    throw new Error('binance ws not open');
  }
  const params = makeSignedParams();
  await sendReq<Record<string, unknown>>('session.logon', params, { timeoutMs: 10_000 });
  isLoggedIn = true;
}

function handleUserTradesStream(event: BinanceUserDataEvent): void {
  const canonSym = event.s ? getCanonFromOderSym(event.s, ExchangeIds.binance) : null;
  if (!canonSym) {
    log.warn({ event }, 'binance executionReport symbol mapping missing');
    return;
  }

  const side = event.S === 'BUY' ? OrderSides.BUY : OrderSides.SELL;
  const executedQty = Number(event.z ?? 0);
  const cummulativeQuoteQty = Number(event.Z ?? 0);
  const priceVwap = executedQty > 0 ? cummulativeQuoteQty / executedQty : 0;
  const feeAmount = Number(event.n ?? 0);
  const feeCurrency = String(event.N ?? '');
  let feeUsd = 0;
  if (feeAmount > 0 && feeCurrency) {
    const feeAssetPrice = getAssetPrice(ExchangeIds.binance, feeCurrency);
    if (feeAssetPrice == null) {
      log.warn({ currency: feeCurrency }, 'missing cached asset price');
    } else {
      feeUsd = feeAssetPrice * feeAmount;
    }
  }

  busRef.emit('trade:order_result', {
    exchange: ExchangeIds.binance,
    symbol: event.s ?? '',
    status: event.X === 'FILLED'
      ? OrderStates.FILLED
      : event.X === 'PARTIALLY_FILLED'
        ? OrderStates.PARTIALLY_FILLED
        : event.X === 'CANCELED'
          ? OrderStates.CANCELLED
          : OrderStates.UNKNOWN,
    orderId: event.i ?? '',
    clientOrderId: event.c,
    transactTime: Number(event.T ?? event.E ?? Date.now()),
    executedQty,
    cummulativeQuoteQty,
    priceVwap,
    fee_amount: Number.isFinite(feeAmount) ? feeAmount : 0,
    fee_currency: feeCurrency,
    fee_usd: feeUsd,
  });

  updateBalancesFromOrderData({
    side,
    baseAsset: getEx(canonSym, ExchangeIds.binance)!.base,
    quoteAsset: getEx(canonSym, ExchangeIds.binance)!.quote,
    executedQty,
    cummulativeQuoteQty,
  });
}

/**
 * orders und balance events
 * @param msgObj 
 * @returns 
 */
function handleUserDataStream(msgObj: BinanceUserDataMessage): void {
  const event = msgObj.event;
  if (!event?.e) return;

  //==========================================================================
  // account balance betreffend
  //==========================================================================
  if (event.e === 'outboundAccountPosition') {
    for (const b of event.B ?? []) {
      const asset = String(b?.a ?? '');
      if (!asset) continue;
      balances[asset] = Number(b?.f ?? 0);
    }
    balancesLoaded = true;
  }

  //==========================================================================
  // alle orders betreffend
  //==========================================================================
  if (event.e === 'executionReport') {
    handleUserTradesStream(event);
  }

  log.debug({
    eventType: event.e,
    subscriptionId: msgObj.subscriptionId,
  }, 'binance user data event');
}

async function subscribeUserDataStream(): Promise<void> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    throw new Error('binance ws not open');
  }

  const result = await sendReq<BinanceUserDataSubscribeResult>('userDataStream.subscribe', {}, { timeoutMs: 10_000 });
  userDataSubscriptionId = result.subscriptionId ?? null;
  log.info({ subscriptionId: userDataSubscriptionId }, 'binance user data stream subscribed');
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
let balanceRefreshTmr: NodeJS.Timeout | null = null;

async function init(cfg: AppConfig, deps?: { bus?: any }): Promise<void> {
  busRef = deps?.bus ?? appBus;
  if (openPromise) { // should not happen
    await openPromise;
    
    if (!balancesLoaded) {
      balances = await fetchBalancesWs();
      balancesLoaded = true;
    }
    return;
  }

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
  const url = 'wss://ws-api.binance.com:443/ws-api/v3';

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
      isLoggedIn = false;
      userDataSubscriptionId = null;
      exState.onWsState('binance-ws-api', WS_STATE.OPEN);
      log.debug({ url }, 'binance ws-api connected');
      try {
        await loginWs();
        await subscribeUserDataStream();
        if (openResolve) {
          openResolve();
          openResolve = null;
          openReject = null;
        }
      } catch (err) {
        log.error({ err }, 'binance ws-api login failed');
        openReject?.(err);
      }
    },

    onMessage: (msg: Buffer) => {
      exState.onWsMessage('binance-ws-api');
      let parsed: any;
      try {
        parsed = JSON.parse(msg.toString());
        // log.debug({msg:parsed}, 'onMessage');
      } catch (e) {
        log.error({ err: e }, 'binance ws-api message parse error');
        return;
      }

      if (!parsed?.id && parsed?.event) {
        handleUserDataStream(parsed);
        return;
      }

      if (!parsed?.id) return;
      // Correlated WS-API response (has id)
      const p = pending.get(parsed.id);
      if (!p) return;

      clearTimeout(p.tmr);
      pending.delete(parsed.id);

      if (parsed.status !== 200) {
        log.error({
          id: parsed.id,
          status: parsed.status,
          method: p.requestContext?.method,
          params: p.requestContext?.params,
          rawErrorResponse: parsed,
        }, 'binance ws-api request failed');
        p.reject(makeWsApiError('binance ws-api request failed', {
          id: parsed.id,
          status: parsed.status,
          method: p.requestContext?.method,
          params: p.requestContext?.params,
          rawErrorResponse: parsed,
        }));
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
      userDataSubscriptionId = null;
      isLoggedIn = false;
      rejectAllPending(new Error(`binance ws closed code=${code} reason=${reason || ''}`));
      openReject?.(new Error('ws closed during init'));
    },

    onError: (err: Error) => {
      exState.onWsError('binance-ws-api', err);
      userDataSubscriptionId = null;
      isLoggedIn = false;
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
  await openPromise;

  if (!balancesLoaded) {
    balances = await fetchBalancesWs();
    balancesLoaded = true;
  }
  startBalanceRefreshLoop();
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
async function fetchBalancesWs(): Promise<Balances> {
  const params = makeSignedParams({ omitZeroBalances: true });

  const result = await sendReq<BinanceAccountStatusResult>('account.status', params, { timeoutMs: 10_000 });

  const out: Balances = {};
  for (const b of result?.balances ?? []) out[b.asset] = Number(b.free ?? 0);
  return out;
}

function isReady(): boolean {
  return wsRef !== null && wsRef.readyState === WebSocket.OPEN && isLoggedIn;
}

function getBalances(): Balances {
  if (!balancesLoaded) {
    log.warn({}, 'getBalances called before balances were loaded');
  }
  return { ...balances };
}

function updateBalancesFromOrderData(params: UpdateBalancesParams): void {
  const baseDelta = Number(params.executedQty ?? 0);
  const quoteDelta = Number(params.cummulativeQuoteQty ?? 0);
  if (!Number.isFinite(baseDelta) || !Number.isFinite(quoteDelta)) {
    log.warn({ params }, 'skip updateBalances: invalid numeric input');
    return;
  }
  const base = params.baseAsset;
  const quote = params.quoteAsset;
  balances[base] = balances[base] ?? 0;
  balances[quote] = balances[quote] ?? 0;

  if (params.side === 'BUY') {
    balances[quote] -= quoteDelta;
    balances[base] += baseDelta;
    return;
  }

  if (params.side === 'SELL') {
    balances[quote] += quoteDelta;
    balances[base] -= baseDelta;
    return;
  }

  log.warn({ side: params.side }, 'skip updateBalances: unsupported side');
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

async function placeOrder(orderParams: PlaceOrderParams): Promise<void> {
  const params = makeSessionParams({
    symbol: orderParams.symbol,
    side: orderParams.side,
    type: orderParams.type,
    quantity: String(orderParams.quantity),
    price: orderParams.price !== undefined ? String(orderParams.price) : undefined,
    newClientOrderId: orderParams.orderId ? String(orderParams.orderId) : undefined,
    // computeCommissionRates: true
  });

  log.debug({params}, 'ORDER!!!!');

  let r: BinancePlaceOrderResult;
  try {
    r = await sendReq<BinancePlaceOrderResult>('order.place', params, { timeoutMs: 10_000 });
  } catch (err) {
    log.error({ err, params }, 'binance placeOrder failed');
    throw err;
  }
  log.debug({ rawOrderResponse: r }, 'placeOrder raw response');

  // beispielantwort von binance api:
// [2026-02-24 19:08:44.610 +0100] DEBUG (executor): placeOrder raw response
//     exchange: "binance"
//     rawOrderResponse: {
//       "symbol": "AXSUSDC",
//       "orderId": 29416377,
//       "orderListId": -1,
//       "clientOrderId": "123456789",
//       "transactTime": 1771956524486,
//       "price": "0.00000000",
//       "origQty": "10.00000000",
//       "executedQty": "10.00000000",
//       "origQuoteOrderQty": "0.00000000",
//       "cummulativeQuoteQty": "12.36000000",
//       "status": "FILLED",
//       "timeInForce": "GTC",
//       "type": "MARKET",
//       "side": "BUY",
//       "workingTime": 1771956524486,
//       "fills": [
//         {
//           "price": "1.23600000",
//           "qty": "10.00000000",
//           "commission": "0.00001500",
//           "commissionAsset": "BNB",
//           "tradeId": 973520
//         }
//       ],
//       "selfTradePreventionMode": "EXPIRE_MAKER"
//     }
  
  // preis ermitteln
  // const cumQuote : number = Number(r.cummulativeQuoteQty);
  // const exeQty : number = Number(r.executedQty);
  // let priceVwap = 0.0;
  // if (exeQty > 1e-3) {
  //   priceVwap = cumQuote / exeQty;
  // }
  
  // // fees ermitteln
  // const totalCommission = (r.fills ?? []).reduce((sum, f) => {
  //   const c = Number(f.commission ?? 0);
  //   return Number.isFinite(c) ? sum + c : sum;
  // }, 0);
  // const commissionAsset = r.fills?.[0]?.commissionAsset;
  // let feeUsd = 0.0;
  // if (commissionAsset) {
  //   const feeAssetPrice = getAssetPrice(ExchangeIds.binance, commissionAsset);
  //   if (feeAssetPrice == null) {
  //     log.warn({ currency: commissionAsset }, 'missing cached asset price');
  //   } else {
  //     feeUsd = feeAssetPrice * totalCommission;
  //   }
  // } else {
  //   log.warn({ currency: commissionAsset }, 'unknown fee currency');
  //   feeUsd = 0.0;
  // }

  // const out : CommonOrderResult = {
  //   exchange: ExchangeIds.binance,
  //   symbol: r.symbol,
  //   status: r.status === 'FILLED' ? OrderStates.FILLED : OrderStates.UNKNOWN,
  //   orderId: r.orderId,
  //   clientOrderId: r.clientOrderId,
  //   transactTime: r.transactTime,
  //   executedQty: exeQty,
  //   cummulativeQuoteQty: cumQuote,
  //   priceVwap: priceVwap,
  //   fee_amount: Number(totalCommission),
  //   fee_currency: commissionAsset ? commissionAsset : 'UNKNOWN',
  //   fee_usd: feeUsd,
  // };
  // return out;
}

async function cancelOrder(p: CancelOrderParams): Promise<void> {
  const params = makeSessionParams({
    symbol: p.symbol,
    origClientOrderId: p.orderId,
    orderId: p.orderId
  });

  const r = await sendReq<BinanceCancelOrderResult>('order.cancel', params, { timeoutMs: 10_000 });
}

function startBalanceRefreshLoop(): void {
  if (process.env.NODE_ENV === 'development') return;
  if (balanceRefreshTmr) return;
  balanceRefreshTmr = setInterval(() => {
    fetchBalancesWs()
      .then((nextBalances) => {
        balances = nextBalances;
        balancesLoaded = true;
      })
      .catch((err: unknown) => {
        log.warn({ err }, 'balance refresh failed');
      });
  }, BALANCE_REFRESH_MS);
  balanceRefreshTmr.unref?.();
}

export const adapter : ExecutorAdapter = {
  init,
  isReady,
  getBalances,
  placeOrder,
  cancelOrder
}
