import crypto from 'crypto';
import fs from 'fs';
import WebSocket from 'ws';

import { getLogger } from '../../common/logger';
const log = getLogger('executor').child({ exchange: 'bitget' });

import { createReconnectWS } from '../../common/ws_reconnect';
import { getExState } from '../../common/exchange_state';
import { WS_STATE } from '../../common/constants';
import { makeClientId } from '../../common/util';
import { getEx, getCanonFromOderSym } from '../../common/symbolinfo';
import { getAssetPrice } from '../../common/symbolinfo_price';
import appBus from '../../bus';

import {
  type Balances,
  type CommonOrderResult,
  type OrderState,
  type PlaceOrderParams,
  type CancelOrderParams,
  type UpdateBalancesParams,
  type PendingEntry,
  type ExecutorAdapter,
  OrderStates
} from '../../types/executor';
import type { AppConfig } from '../../types/config';
import { OrderSides, OrderTypes, ExchangeIds } from '../../types/common';
import type { ReconnectDelayOverrideArgs } from '../../types/ws_reconnect';

type BitgetSpotAssetRow = {
  coin?: string;
  available?: string;
};

type BitgetPlaceOrderData = {
  orderId?: string;
  clientOid?: string;
};

type BitgetCancelOrderData = {
  orderId?: string;
  clientOid?: string;
};

type BitgetTradeArg<TParams> = {
  id?: string;
  instType?: string;
  channel?: string;
  instId?: string;
  params?: TParams;
};

// type BitgetPlaceOrderResult = {
//   event?: string;
//   code?: string | number;
//   msg?: string;
//   arg?: BitgetTradeArg<BitgetPlaceOrderData>[];
// };

type BitgetCancelOrderResult = {
  event?: string;
  code?: string | number;
  msg?: string;
  arg?: BitgetTradeArg<BitgetCancelOrderData>[];
};

type BitgetApiResponse<T> = {
  code?: string;
  msg?: string;
  data?: T;
};

type BitgetOrderRef = {
  symbol: string;
  orderId?: string;
  clientOid?: string;
  status: OrderState;
  orderChannelTmr?: NodeJS.Timeout;
};

type BitgetOrdersChannelFeeDetail = {
  feeCoin: string;
  fee: string;
};

type BitgetOrdersChannelRow = {
  instId: string;
  orderId: string;
  clientOid?: string;
  side: string;
  fillTime?: string;
  uTime?: string;
  cTime?: string;
  accBaseVolume?: string;
  baseVolume?: string;
  priceAvg?: string;
  fillPrice?: string;
  notional?: string;
  fillFee?: string;
  fillFeeCoin?: string;
  feeDetail?: BitgetOrdersChannelFeeDetail[];
  status?: string;
};

type BitgetOrdersChannelMsg = {
  action?: string;
  arg?: {
    channel?: string;
    instId?: string;
    instType?: string;
  };
  data?: BitgetOrdersChannelRow[];
  ts?: number | string;
};

function makeBitgetRestError(message: string, context: Record<string, unknown>): Error {
  const err = new Error(message) as Error & { context?: Record<string, unknown> };
  err.context = context;
  return err;
}

function makeBitgetWsError(message: string, context: Record<string, unknown>): Error {
  const err = new Error(message) as Error & { context?: Record<string, unknown> };
  err.context = context;
  return err;
}

function signRsaSha256Base64(privateKeyPem: string, data: string): string {
  return crypto.sign('RSA-SHA256', Buffer.from(data), privateKeyPem).toString('base64');
}

function makeBitgetSign(opts: {
  privateKeyPem: string;
  timestamp: string;
  method: string;
  requestPathWithQuery: string;
  body: string;
}): string {
  const prehash = `${opts.timestamp}${opts.method.toUpperCase()}${opts.requestPathWithQuery}${opts.body}`;
  return signRsaSha256Base64(opts.privateKeyPem, prehash);
}

function bitgetRestHeaders(opts: {
  apiKey: string;
  privateKeyPem: string;
  passphrase: string;
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  requestPathWithQuery: string;
  body: string;
  timestamp?: string;
}): Record<string, string> {
  const ts = opts.timestamp ?? String(Date.now());
  const sign = makeBitgetSign({
    privateKeyPem: opts.privateKeyPem,
    timestamp: ts,
    method: opts.method,
    requestPathWithQuery: opts.requestPathWithQuery,
    body: opts.body,
  });
  return {
    'ACCESS-KEY': opts.apiKey,
    'ACCESS-SIGN': sign,
    'ACCESS-TIMESTAMP': ts,
    'ACCESS-PASSPHRASE': opts.passphrase,
    'Content-Type': 'application/json',
    locale: 'en-US',
  };
}

async function bitgetPrivateRest<T>(opts: {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  path: string;
  query?: string;
  body?: Record<string, unknown>;
}): Promise<T> {
  const host = process.env.BITGET_REST_HOST ?? 'https://api.bitget.com';
  const apiKey = process.env.BITGET_API_KEY!;
  const passphrase = process.env.BITGET_API_PASSPHRASE!;
  if (!rsaPrivateKeyPem) {
    throw new Error('Missing Bitget RSA private key');
  }

  const query = opts.query ?? '';
  const bodyStr = opts.body ? JSON.stringify(opts.body) : '';
  const requestPathWithQuery = `${opts.path}${query ? `?${query}` : ''}`;
  const headers = bitgetRestHeaders({
    apiKey,
    privateKeyPem: rsaPrivateKeyPem,
    passphrase,
    method: opts.method,
    requestPathWithQuery,
    body: bodyStr,
  });
  const url = `${host}${requestPathWithQuery}`;
  const res = await fetch(url, {
    method: opts.method,
    headers,
    body: opts.method === 'GET' ? undefined : bodyStr,
  });
  const json = (await res.json()) as BitgetApiResponse<T>;
  const codeNum = Number(json?.code);
  if (!res.ok || !Number.isFinite(codeNum) || codeNum !== 0) {
    const msg = json?.msg ?? `status=${res.status}`;
    throw makeBitgetRestError(`bitget rest error ${opts.method} ${requestPathWithQuery}: ${msg}`, {
      method: opts.method,
      path: opts.path,
      query,
      requestPathWithQuery,
      body: opts.body,
      status: res.status,
      rawErrorResponse: json,
    });
  }
  return json.data as T;
}

let mgr: ReturnType<typeof createReconnectWS> | null = null;
let wsRef: WebSocket | null = null;
let busRef: any;
const pending: Map<string, PendingEntry> = new Map();
const pendingOrderRefs: Map<string, BitgetOrderRef> = new Map();
let balances: Balances = {};
let balancesLoaded = false;
let isLoggedIn = false;
let balanceRefreshTmr: NodeJS.Timeout | null = null;
let openResolve: (() => void) | null = null;
let openReject: ((err: unknown) => void) | null = null;
let openPromise: Promise<void> | undefined;
let rsaPrivateKeyPem = '';
const BALANCE_REFRESH_MS = 15 * 60 * 1000; // [ms] 15 min
const ORDER_CHANNEL_PENDING_TTL_MS = 30_000;

let loginPending:
  | { resolve: () => void; reject: (err: unknown) => void; tmr: NodeJS.Timeout }
  | null = null;

function rejectLoginPending(err: unknown): void {
  if (!loginPending) return;
  clearTimeout(loginPending.tmr);
  loginPending.reject(err);
  loginPending = null;
}

function rejectAllPending(err: unknown): void {
  for (const [id, p] of pending.entries()) {
    clearTimeout(p.tmr);
    p.reject(err);
    pending.delete(id);
  }
}

function clearOrderChannelTimeout(ref?: BitgetOrderRef): void {
  if (!ref?.orderChannelTmr) return;
  clearTimeout(ref.orderChannelTmr);
  ref.orderChannelTmr = undefined;
}

function sendFrame<T>(op: 'trade' | 'login', payload: Record<string, unknown>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<T> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`bitget ws not open (op=${op})`));
  }

  const id = String(payload.id ?? makeClientId()).slice(0, 40);
  const requestArg = { ...payload, id };
  const frame = { op, args: [requestArg] };
  log.debug({frame}, 'sendFrame');

  return new Promise<T>((resolve, reject) => {
    const tmr = setTimeout(() => {
      pending.delete(id);
      reject(makeBitgetWsError(`bitget ws timeout op=${op} id=${id}`, {
        id,
        op,
        arg: requestArg,
      }));
    }, timeoutMs);

    pending.set(id, {
      resolve,
      reject,
      tmr,
      requestContext: { method: op, params: requestArg },
    });

    try {
      wsRef?.send(JSON.stringify(frame));
    } catch (err) {
      clearTimeout(tmr);
      pending.delete(id);
      log.error({ err, frame }, 'bitget ws send failed');
      reject(err);
    }
  });
}

function sendReq<T>(reqArg: Record<string, unknown>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<T> {
  return sendFrame<T>('trade', reqArg, { timeoutMs });
}

async function loginWs(): Promise<void> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    throw new Error('bitget ws not open');
  }
  const apiKey = process.env.BITGET_API_KEY!;
  const passphrase = process.env.BITGET_API_PASSPHRASE!;
  if (!rsaPrivateKeyPem) {
    throw new Error('Missing Bitget RSA private key');
  }
  const timestamp = String(Date.now());
  const args = {
    apiKey,
    passphrase,
    timestamp,
    sign: signRsaSha256Base64(rsaPrivateKeyPem, `${timestamp}GET/user/verify`),
  };
  await new Promise<void>((resolve, reject) => {
    const tmr = setTimeout(() => {
      loginPending = null;
      reject(makeBitgetWsError('bitget ws login timeout', {
        op: 'login',
        args,
      }));
    }, 10_000);
    loginPending = { resolve, reject, tmr };
    const frame = { op: 'login', args: [args] };
    try {
      wsRef?.send(JSON.stringify(frame));
    } catch (err) {
      clearTimeout(tmr);
      loginPending = null;
      log.error({ err, frame }, 'bitget ws login send failed');
      reject(err);
    }
  });
  isLoggedIn = true;
}

async function subscribeOrders(cfg: AppConfig): Promise<void> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    throw new Error('bitget ws not open');
  }
  const args = [];
  for (const sym of cfg.bot.execution_symbols) {
    const instId = getEx(sym, ExchangeIds.bitget)?.orderKey;
    if (!instId) {
      throw new Error(`${sym} is missing. check symbolinfo for bitget`);
    };
    args.push({
      instType: 'SPOT',
      channel: 'orders',
      instId,
    });
  }
  if (args.length === 0) {
    return;
  }
  const frame = {
    op: 'subscribe',
    args,
  };
  wsRef.send(JSON.stringify(frame));
  // log.debug({ symbolsCount: args.length }, 'bitget orders subscribe sent');
}

function handleOrdersChannelMsg(msgObj: BitgetOrdersChannelMsg) {
//   [2026-03-25 08:21:19.588 +0100] DEBUG (executor): onMessage
//     exchange: "bitget"
//     parsed: {
//       "action": "snapshot",
//       "arg": {
//         "instType": "SPOT",
//         "channel": "orders",
//         "instId": "AXSUSDT"
//       },
//       "data": [
//         {
//           "instId": "AXSUSDT",
//           "orderId": "1420599686759628800",
//           "clientOid": "my-123456789",
//           "size": "12",
//           "newSize": "12",
//           "notional": "12",
//           "orderType": "market",
//           "force": "gtc",
//           "side": "buy",
//           "fillPrice": "1.115",
//           "tradeId": "1420599686786174976",
//           "baseVolume": "10.7623",
//           "fillTime": "1774423279472",
//           "fillFee": "-0.0046916096178282",
//           "fillFeeCoin": "BGB",
//           "tradeScope": "T",
//           "accBaseVolume": "10.7623",
//           "priceAvg": "1.115",
//           "status": "partially_filled",
//           "cTime": "1774423279466",
//           "uTime": "1774423279495",
//           "feeDetail": [
//             {
//               "feeCoin": "BGB",
//               "fee": "-0.0046916096178282"
//             }
//           ],
//           "enterPointSource": "API",
//           "stpMode": "none"
//         }
//       ],
//       "ts": 1774423279501
//     }
// [2026-03-25 08:21:19.591 +0100] DEBUG (executor): onMessage
//     exchange: "bitget"
//     parsed: {
//       "action": "snapshot",
//       "arg": {
//         "instType": "SPOT",
//         "channel": "orders",
//         "instId": "AXSUSDT"
//       },
//       "data": [
//         {
//           "instId": "AXSUSDT",
//           "orderId": "1420599686759628800",
//           "clientOid": "my-123456789",
//           "size": "12",
//           "newSize": "12",
//           "notional": "12",
//           "orderType": "market",
//           "force": "gtc",
//           "side": "buy",
//           "accBaseVolume": "10.7623",
//           "priceAvg": "1.115",
//           "status": "filled",
//           "cTime": "1774423279466",
//           "uTime": "1774423279495",
//           "feeDetail": [
//             {
//               "feeCoin": "BGB",
//               "fee": "-0.0046916096178282"
//             }
//           ],
//           "enterPointSource": "API",
//           "stpMode": "none"
//         }
//       ],
//       "ts": 1774423279503
//     }
  if (msgObj?.arg?.channel !== 'orders' || !Array.isArray(msgObj?.data)) {
    return [];
  }
  const out: CommonOrderResult[] = [];
  for (const row of msgObj.data) {
    const ref = row.clientOid ? pendingOrderRefs.get(row.clientOid) : undefined;
    let status: OrderState = OrderStates.UNKNOWN;
    if (row.status === 'filled') {
      status = OrderStates.FILLED;
      clearOrderChannelTimeout(ref);
    } else if (row.status === 'partially_filled') {
      status = OrderStates.PARTIALLY_FILLED;
    } else if (row.status === 'cancelled') {
      status = OrderStates.CANCELLED;
    }
    if (ref) {
      ref.status = status;
    }
    if (status !== OrderStates.FILLED) {
      if (status === OrderStates.CANCELLED) {
        log.warn({data:row}, 'order cancelled');
      }
      continue;
    }

    // fees ermitteln
    let totalCommission = 0.0;
    let feeUsd = 0.0;
    let feeCurrency = '';
    // gesamt fee in BGB und fee coin ermitteln (sollte immer BGB sein)
    if (Array.isArray(row.feeDetail) && row.feeDetail.length > 0) {
      feeCurrency = row.feeDetail[0].feeCoin;
      row.feeDetail.forEach((f) => {totalCommission += Math.abs(Number(f.fee))});
    }
    if (totalCommission > 0.0) {
      const feeAssetPrice = getAssetPrice(ExchangeIds.bitget, 'BGB'); // 15 min genauen preis holen
      if (feeAssetPrice == null) {
        log.warn({ currency: 'BGB' }, 'missing cached asset price');
      } else {
        feeUsd = feeAssetPrice * totalCommission;
      }
    }
    const canonSym = getCanonFromOderSym(row.instId,ExchangeIds.bitget);
    if (!canonSym) {
      log.warn({sym: row.instId}, 'could not find canon symbol');
      continue;
    }
    const symInfo = getEx(canonSym, ExchangeIds.bitget);
    if (!symInfo) { // should not happen
      log.warn({canonSym}, 'could not find symbolinfo');
      continue;
    }
    const qty = Number(row.accBaseVolume);
    const cumQuoteQty = Number(row.notional);
    updateBalancesFromOrderData({
      side: row.side === 'buy' ? OrderSides.BUY : OrderSides.SELL,
      baseAsset: symInfo.base,
      quoteAsset: symInfo.quote,
      executedQty: qty,
      cummulativeQuoteQty: cumQuoteQty,
    });
    busRef.emit('trade:order_result', {
      exchange: ExchangeIds.bitget,
      symbol: row.instId, // order key, nicht canon !!!
      status,
      orderId: row.orderId,
      clientOrderId: row.clientOid, // sollte intent id entsprechen
      transactTime: Number(row.fillTime),
      executedQty: qty,
      cummulativeQuoteQty: cumQuoteQty,
      priceVwap: Number(row.priceAvg),
      fee_amount: Number.isFinite(Number(
        row.fillFee ?? (Array.isArray(row.feeDetail) ? row.feeDetail[0]?.fee : undefined) ?? 0
      ))
        ? Number(row.fillFee ?? (Array.isArray(row.feeDetail) ? row.feeDetail[0]?.fee : undefined) ?? 0)
        : 0,
      fee_currency : feeCurrency,
      fee_usd: feeUsd,
    });
  }
}

async function init(cfg: AppConfig, deps?: { bus?: any }): Promise<void> {
  busRef = deps?.bus ?? appBus;
  if (openPromise) {
    await openPromise;
    if (!balancesLoaded) {
      balances = await fetchBalances();
      balancesLoaded = true;
    }
    return;
  }

  const apiKey = process.env.BITGET_API_KEY;
  const rsaPrivateKeyFile = process.env.BITGET_RSA_PRIVATE_KEY_FILE;
  const passphrase = process.env.BITGET_API_PASSPHRASE;
  if (!apiKey ) {
    throw new Error('Missing BITGET_API_KEY in .env');
  }
  if (!passphrase) {
    throw new Error('Missing BITGET_API_PASSPHRASE in .env');
  }
  if (!rsaPrivateKeyFile) {
    throw new Error('Missing BITGET_RSA_PRIVATE_KEY_FILE in .env');
  }
  rsaPrivateKeyPem = fs.readFileSync(rsaPrivateKeyFile, 'utf8');

  openPromise = new Promise<void>((res, rej) => {
    openResolve = res;
    openReject = rej;
  });

  const exState = getExState();
  const wsUrl = process.env.BITGET_WS_PRIVATE_URL ?? 'wss://ws.bitget.com/v2/ws/private';

  mgr = createReconnectWS({
    name: 'bitget-ws-private',
    log,
    staleTimeoutMs: null,
    heartbeatIntervalMs: 20_000,

    connect: () => {
      const ws = new WebSocket(wsUrl);
      wsRef = ws;
      return ws;
    },

    onOpen: async (ws: WebSocket) => {
      wsRef = ws;
      isLoggedIn = false;
      exState.onWsState('bitget-ws-private', WS_STATE.OPEN);
      log.debug({ wsUrl }, 'ws private connected');
      try {
        await loginWs();
        await subscribeOrders(cfg);
        log.info({}, 'log in successful');
        openResolve?.();
        openResolve = null;
        openReject = null;
      } catch (err) {
        log.error({ err }, 'ws private login failed');
        openReject?.(err);
      }
    },

    onMessage: (msg: Buffer) => {
      exState.onWsMessage('bitget-ws-private');
      let parsed: any;
      const raw = msg.toString();
      if (raw === 'pong') {
        return;
      }
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        log.error({ err }, 'bitget ws message parse error');
        return;
      }
      if (parsed.event === 'login') {
        if (!loginPending) return;
        const code = Number(parsed?.code);
        if (code === 0) {
          clearTimeout(loginPending.tmr);
          loginPending.resolve();
          loginPending = null;
          return;
        }
        log.error({ rawErrorResponse: parsed }, 'bitget ws login failed');
        const err = makeBitgetWsError(`bitget ws login failed: ${parsed?.msg ?? 'unknown error'}`, {
          rawErrorResponse: parsed,
        });
        rejectLoginPending(err);
        return;
      } else if (parsed.event === 'error') {
        log.error({response:parsed}, 'onMessage error');
        return;
      } else if (parsed.event === 'subscribe') { // wird fuer jedes subscribed symbol einzeln empfangen (auch wenn diese per array requested wurden)
        log.debug({ response: parsed }, 'bitget subscribe ack');
        return;
      } else if (parsed.arg?.channel === 'orders') {
        handleOrdersChannelMsg(parsed);
        return;
      }
      log.debug({parsed}, 'onMessage');

      const responseArg = Array.isArray(parsed?.arg) ? parsed.arg[0] : parsed?.arg;
      const reqId = responseArg?.id ? String(responseArg.id) : null;
      if (!reqId) return;

      const p = pending.get(reqId); // wartet noch eine order auf eine antwort?
      if (!p) return;

      clearTimeout(p.tmr);
      pending.delete(reqId);

      const code = String(parsed?.code ?? '');
      if (parsed?.event === 'error' || code !== '0') {
        log.error({
          reqId,
          op: p.requestContext?.method,
          params: p.requestContext?.params,
          rawErrorResponse: parsed,
        }, 'bitget ws trade request failed');
        p.reject(makeBitgetWsError(`bitget ws trade failed: ${parsed?.msg ?? 'unknown error'}`, {
          reqId,
          op: p.requestContext?.method,
          params: p.requestContext?.params,
          rawErrorResponse: parsed,
        }));
        return;
      }
      p.resolve({
        event: parsed?.event,
        code: parsed?.code,
        msg: parsed?.msg,
        arg: responseArg ? [responseArg] : [],
      });
    },

    onReconnect: () => {
      exState.onWsReconnect('bitget-ws-private');
    },

    onClose: (code: number, reason: string) => {
      exState.onWsState('bitget-ws-private', WS_STATE.CLOSED);
      wsRef = null;
      isLoggedIn = false;
      rejectAllPending(new Error(`bitget ws closed code=${code} reason=${reason || ''}`));
      rejectLoginPending(new Error(`bitget ws closed code=${code} reason=${reason || ''}`));
      openReject?.(new Error('ws closed during init'));
    },

    onError: (err: Error) => {
      exState.onWsError('bitget-ws-private', err);
      isLoggedIn = false;
      rejectLoginPending(err);
      openReject?.(err);
    },

    delayOverrideMs: ({ type, code, reason, err }: ReconnectDelayOverrideArgs): number | null => {
      if (type === 'close' && code === 1006) return 1000;

      const r = reason || '';
      const e = (err?.message || '').toLowerCase();
      if (code === 1008 || r.includes('policy')) return 120_000;
      if (e.includes('429') || r.includes('rate')) return 90_000;
      if (code === 1013 || r.includes('try again later')) return 60_000;
      return null;
    },
  });

  mgr.start();
  await openPromise;
  startBalanceRefreshLoop();
  if (!balancesLoaded) {
    balances = await fetchBalances();
    balancesLoaded = true;
  }
}

async function fetchBalances(): Promise<Balances> {
  const rows = await bitgetPrivateRest<BitgetSpotAssetRow[]>({
    method: 'GET',
    path: '/api/v2/spot/account/assets',
  });
  const out: Balances = {};
  for (const r of rows ?? []) {
    const c = String(r.coin ?? '');
    if (!c) continue;
    out[c] = Number(r.available ?? 0);
  }
  return out;
}

function startBalanceRefreshLoop(): void {
  if (process.env.NODE_ENV === 'development') return;
  if (balanceRefreshTmr) return;
  balanceRefreshTmr = setInterval(() => {
    fetchBalances()
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

  if (params.side === OrderSides.BUY) {
    balances[quote] -= quoteDelta;
    balances[base] += baseDelta;
    return;
  }
  if (params.side === OrderSides.SELL) {
    balances[quote] += quoteDelta;
    balances[base] -= baseDelta;
    return;
  }

  log.warn({ side: params.side }, 'skip updateBalances: unsupported side');
}

async function placeOrder(orderParams: PlaceOrderParams): Promise<void> {
  const reqBody: Record<string, unknown> = {
    symbol: orderParams.symbol,
    orderType: String(orderParams.type).toLowerCase(),
    side: String(orderParams.side).toLowerCase(),
    clientOid: orderParams.orderId,
  };
  if (orderParams.type === OrderTypes.MARKET && orderParams.side === OrderSides.BUY && orderParams.q !== undefined) {
    reqBody.size = String(orderParams.q);
  } else {
    reqBody.size = String(orderParams.quantity);
  }
  if (orderParams.type !== OrderTypes.MARKET) {
    reqBody.force = 'gtc';
  }
  if (orderParams.price !== undefined) {
    reqBody.price = String(orderParams.price);
  }
  log.debug({ reqBody }, 'ORDER!!!!');
  let r: BitgetPlaceOrderData;
  try {
    r = await bitgetPrivateRest<BitgetPlaceOrderData>({
      method: 'POST',
      path: '/api/v2/spot/trade/place-order',
      body: reqBody,
    });
  } catch (err) {
    log.error({ err, reqBody }, 'bitget placeOrder failed');
    throw err;
  }
  log.debug({ reqBody, rawOrderResponse: r }, 'placeOrder raw response');

  if (!r) {
    throw new Error('bitget placeOrder returned empty response');
  }

  const orderId = String(r.orderId ?? '');
  const clientOid = r.clientOid ?? orderParams.orderId;
  const orderRef: BitgetOrderRef = {
    symbol: orderParams.symbol,
    orderId,
    clientOid,
    status: OrderStates.UNKNOWN,
  };
  if (clientOid) {
    orderRef.orderChannelTmr = setTimeout(() => {
      pendingOrderRefs.delete(clientOid);
      log.warn({ clientOid, orderId, symbol: orderParams.symbol }, 'bitget pending order ref expired before orders channel event');
    }, ORDER_CHANNEL_PENDING_TTL_MS);
    orderRef.orderChannelTmr.unref?.();
    pendingOrderRefs.set(clientOid, orderRef);
  }
}

async function cancelOrder(p: CancelOrderParams): Promise<void> {
  if (!isReady()) throw new Error('bitget ws not ready');

  const params: Record<string, unknown> = {};
  if (p.orderId !== undefined) {
    const v = String(p.orderId);
    if (v.length > 0) {
      if (/^\d+$/.test(v)) {
        params.orderId = v;
      } else {
        params.clientOid = v;
      }
    }
  }
  const reqArg = {
    instType: 'SPOT',
    instId: p.symbol,
    channel: 'cancel-order',
    params,
  };

  let data: BitgetCancelOrderResult;
  try {
    data = await sendReq<BitgetCancelOrderResult>(reqArg, { timeoutMs: 10_000 });
  } catch (err) {
    log.error({ err, reqArg }, 'bitget cancelOrder failed');
    throw err;
  }
}

export const adapter: ExecutorAdapter = {
  init,
  isReady,
  getBalances,
  placeOrder,
  cancelOrder,
};
