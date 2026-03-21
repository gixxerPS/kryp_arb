import crypto from 'crypto';
import WebSocket from 'ws';

import { getLogger } from '../../common/logger';
const log = getLogger('executor').child({ exchange: 'bitget' });

import { createReconnectWS } from '../../common/ws_reconnect';
import { getExState } from '../../common/exchange_state';
import { WS_STATE } from '../../common/constants';
import { makeClientId } from '../../common/util';

import {
  type Balances,
  type CommonOrderResult,
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

type BitgetApiResponse<T> = {
  code?: string;
  msg?: string;
  data?: T;
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

function hmacSha256Base64(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64');
}

function makeBitgetSign(opts: {
  secret: string;
  timestamp: string;
  method: string;
  requestPathWithQuery: string;
  body: string;
}): string {
  const prehash = `${opts.timestamp}${opts.method.toUpperCase()}${opts.requestPathWithQuery}${opts.body}`;
  return hmacSha256Base64(opts.secret, prehash);
}

function bitgetRestHeaders(opts: {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  requestPathWithQuery: string;
  body: string;
  timestamp?: string;
}): Record<string, string> {
  const ts = opts.timestamp ?? String(Date.now());
  const sign = makeBitgetSign({
    secret: opts.apiSecret,
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
  const apiSecret = process.env.BITGET_API_SECRET!;
  const passphrase = process.env.BITGET_API_PASSPHRASE!;

  const query = opts.query ?? '';
  const bodyStr = opts.body ? JSON.stringify(opts.body) : '';
  const requestPathWithQuery = `${opts.path}${query ? `?${query}` : ''}`;
  const headers = bitgetRestHeaders({
    apiKey,
    apiSecret,
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
  if (!res.ok || json?.code !== '00000') {
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

function makeWsLoginArgs() {
  const apiKey = process.env.BITGET_API_KEY!;
  const apiSecret = process.env.BITGET_API_SECRET!;
  const passphrase = process.env.BITGET_API_PASSPHRASE!;
  const timestampSec = String(Math.floor(Date.now() / 1000));
  const sign = hmacSha256Base64(apiSecret, `${timestampSec}GET/user/verify`);

  return {
    apiKey,
    passphrase,
    timestamp: timestampSec,
    sign,
  };
}

let mgr: ReturnType<typeof createReconnectWS> | null = null;
let wsRef: WebSocket | null = null;
const pending: Map<string, PendingEntry> = new Map();
let balances: Balances = {};
let balancesLoaded = false;
let isLoggedIn = false;
let balanceRefreshTmr: NodeJS.Timeout | null = null;
let openResolve: (() => void) | null = null;
let openReject: ((err: unknown) => void) | null = null;
let openPromise: Promise<void> | undefined;
const BALANCE_REFRESH_MS = 15 * 60 * 1000; // [ms] 15 min

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

function sendTradeReq<T>(arg: Record<string, unknown>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<T> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('bitget ws not open (op=trade)'));
  }

  const id = String(arg.id ?? makeClientId()).slice(0, 40);
  const requestArg = { ...arg, id };
  const frame = { op: 'trade', args: [requestArg] };

  return new Promise<T>((resolve, reject) => {
    const tmr = setTimeout(() => {
      pending.delete(id);
      reject(makeBitgetWsError(`bitget ws timeout op=trade id=${id}`, {
        id,
        op: 'trade',
        arg: requestArg,
      }));
    }, timeoutMs);

    pending.set(id, {
      resolve,
      reject,
      tmr,
      requestContext: { method: 'trade', params: requestArg },
    });

    try {
      wsRef?.send(JSON.stringify(frame));
    } catch (err) {
      clearTimeout(tmr);
      pending.delete(id);
      log.error({ err, frame }, 'bitget ws trade send failed');
      reject(err);
    }
  });
}

async function loginWs(): Promise<void> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    throw new Error('bitget ws not open');
  }

  const args = makeWsLoginArgs();
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

async function init(_cfg: AppConfig): Promise<void> {
  if (openPromise) {
    await openPromise;
    if (!balancesLoaded) {
      balances = await fetchBalances();
      balancesLoaded = true;
    }
    return;
  }

  const apiKey = process.env.BITGET_API_KEY;
  const apiSecret = process.env.BITGET_API_SECRET;
  const passphrase = process.env.BITGET_API_PASSPHRASE;
  if (!apiKey || !apiSecret || !passphrase) {
    throw new Error('Missing Bitget API credentials');
  }

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
      try {
        parsed = JSON.parse(msg.toString());
      } catch (err) {
        log.error({ err }, 'bitget ws message parse error');
        return;
      }

      if (parsed?.event === 'login' && loginPending) {
        const code = String(parsed?.code ?? '');
        if (code === '0') {
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
      }

      const responseArg = Array.isArray(parsed?.arg) ? parsed.arg[0] : parsed?.arg;
      const reqId = responseArg?.id ? String(responseArg.id) : null;
      if (!reqId) return;

      const p = pending.get(reqId);
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

      p.resolve(responseArg?.params ?? {});
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

async function placeOrder(test: boolean, orderParams: PlaceOrderParams): Promise<CommonOrderResult> {
  if (!isReady()) throw new Error('bitget ws not ready');
  if (test) {
    log.warn({ orderParams }, 'bitget ws placeOrder test flag ignored');
  }

  const clientOid = orderParams.orderId ?? makeClientId();
  const params: Record<string, unknown> = {
    orderType: String(orderParams.type).toLowerCase(),
    side: String(orderParams.side).toLowerCase(),
    force: orderParams.type === OrderTypes.MARKET ? 'ioc' : 'gtc',
    clientOid,
  };

  if (orderParams.type === OrderTypes.MARKET && orderParams.side === OrderSides.BUY && orderParams.q !== undefined) {
    params.size = String(orderParams.q);
  } else {
    params.size = String(orderParams.quantity);
  }
  if (orderParams.price !== undefined) {
    params.price = String(orderParams.price);
  }

  const reqArg = {
    instType: 'SPOT',
    instId: orderParams.symbol,
    channel: 'place-order',
    params,
  };
  log.debug({ reqArg }, 'ORDER!!!!');
  let data: BitgetPlaceOrderData;
  try {
    data = await sendTradeReq<BitgetPlaceOrderData>(reqArg, { timeoutMs: 10_000 });
  } catch (err) {
    log.error({ err, reqArg }, 'bitget placeOrder failed');
    throw err;
  }
  log.debug({ reqArg, rawOrderResponse: data }, 'placeOrder raw response');

  // Bitget place-order liefert i. d. R. nur IDs. Fill-Details kommen asynchron
  // oder via nachgelagerter Detail-API. Daher conservative Status=UNKNOWN.
  return {
    exchange: ExchangeIds.bitget,
    symbol: orderParams.symbol,
    status: OrderStates.UNKNOWN,
    orderId: String(data?.orderId ?? ''),
    clientOrderId: data?.clientOid ?? clientOid,
    transactTime: Date.now(),
    executedQty: 0,
    cummulativeQuoteQty: 0,
    priceVwap: 0,
    fee_amount: 0,
    fee_currency: '',
    fee_usd: 0,
  };
}

async function cancelOrder(p: CancelOrderParams): Promise<CommonOrderResult> {
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

  let data: BitgetCancelOrderData;
  try {
    data = await sendTradeReq<BitgetCancelOrderData>(reqArg, { timeoutMs: 10_000 });
  } catch (err) {
    log.error({ err, reqArg }, 'bitget cancelOrder failed');
    throw err;
  }

  return {
    exchange: ExchangeIds.bitget,
    symbol: p.symbol,
    status: OrderStates.CANCELLED,
    orderId: String(data?.orderId ?? p.orderId ?? ''),
    clientOrderId: data?.clientOid ?? (typeof p.orderId === 'string' ? p.orderId : undefined),
    transactTime: Date.now(),
    executedQty: 0,
    cummulativeQuoteQty: 0,
    priceVwap: 0,
    fee_amount: 0,
    fee_currency: '',
    fee_usd: 0,
  };
}

export const adapter: ExecutorAdapter = {
  init,
  isReady,
  getBalances,
  updateBalancesFromOrderData,
  placeOrder,
  cancelOrder,
};
