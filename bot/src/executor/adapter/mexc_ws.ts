import crypto from 'crypto';
import WebSocket from 'ws';

import { getLogger } from '../../common/logger';
const log = getLogger('executor').child({ exchange: 'mexc' });
import { createReconnectWS } from '../../common/ws_reconnect';
import { getExState } from '../../common/exchange_state';
import { WS_STATE } from '../../common/constants';
import { getCanonFromOderSym, getEx } from '../../common/symbolinfo';
import { getAssetPrice } from '../../common/symbolinfo_price';
import appBus from '../../bus';

import {
  type Balances,
  type CommonOrderResult,
  type OrderState,
  type PlaceOrderParams,
  type CancelOrderParams,
  type UpdateBalancesParams,
  type ExecutorAdapter,
  OrderStates,
} from '../../types/executor';
import type { AppConfig } from '../../types/config';
import { ExchangeIds, OrderSides, OrderTypes } from '../../types/common';

type MexcBalanceRow = {
  asset?: string;
  free?: string;
  locked?: string;
};

type MexcAccountInfo = {
  balances?: MexcBalanceRow[];
};

type MexcNewOrderResponse = {
  symbol: string;
  orderId: string;
  orderListId?: number;
  price?: string;
  origQty?: string;
  type?: string;
  side?: string;
  stpMode?: string;
  transactTime: number;
};

type MexcCancelOrderResponse = {
  symbol: string;
  origClientOrderId?: string;
  orderId: string | number;
  clientOrderId?: string;
  price?: string;
  origQty?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  status?: string;
  timeInForce?: string;
  type?: string;
  side?: string;
};

type MexcListenKeyResponse = {
  listenKey?: string;
};

type MexcPrivateDealRow = {
  price?: string;
  quantity?: string;
  amount?: string;
  tradeType?: number; // 1=buy, 2=sell
  tradeId?: string;
  orderId?: string;
  feeAmount?: string;
  feeCurrency?: string;
  clientOrderId?: string;
  time?: number;
};

type MexcUserDataMsg = {
  channel?: string;
  symbol?: string;
  sendTime?: number;
  privateDeals?: MexcPrivateDealRow;
};

function makeMexcRestError(message: string, context: Record<string, unknown>): Error {
  const err = new Error(message) as Error & { context?: Record<string, unknown> };
  err.context = context;
  return err;
}

function signHmacSha256Hex(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');
}

async function mexcPrivateRest<T>(opts: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  params?: Record<string, string | number | undefined>;
}): Promise<T> {
  const host = process.env.MEXC_REST_HOST ?? 'https://api.mexc.com';
  const apiKey = process.env.MEXC_API_KEY;
  const apiSecret = process.env.MEXC_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('Missing MEXC API credentials');
  }

  const baseParams = {
    ...(opts.params ?? {}),
    recvWindow: 15_000,
    timestamp: Date.now(),
  };
  const query = buildQuery(baseParams);
  const signature = signHmacSha256Hex(apiSecret, query);
  const requestPathWithQuery = `${opts.path}?${query}&signature=${signature}`;
  const url = `${host}${requestPathWithQuery}`;

  const res = await fetch(url, {
    method: opts.method,
    headers: {
      'Content-Type': 'application/json',
      'X-MEXC-APIKEY': apiKey,
    },
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = text;
  }

  if (!res.ok || (json && typeof json === 'object' && typeof json.code === 'number' && json.code !== 200 && json.code !== 0)) {
    const msg = typeof json?.msg === 'string'
      ? json.msg
      : `status=${res.status}`;
    throw makeMexcRestError(`mexc rest error ${opts.method} ${opts.path}: ${msg}`, {
      method: opts.method,
      path: opts.path,
      params: baseParams,
      status: res.status,
      rawErrorResponse: json,
    });
  }

  return json as T;
}

let balances: Balances = {};
let balancesLoaded = false;
let initialized = false;
let mgr: ReturnType<typeof createReconnectWS> | null = null;
let wsRef: WebSocket | null = null;
let busRef: any;
let listenKey = '';
let openPromise: Promise<void> | undefined;
let openResolve: (() => void) | null = null;
let openReject: ((err: unknown) => void) | null = null;
let balanceRefreshTmr: NodeJS.Timeout | null = null;
let listenKeyKeepAliveTmr: NodeJS.Timeout | null = null;
const BALANCE_REFRESH_MS = 15 * 60 * 1000; // [ms] => alle 15 min
const LISTEN_KEY_KEEPALIVE_MS = 30 * 60 * 1000; // [ms] => alle 30 min

async function fetchBalances(): Promise<Balances> {
  const result = await mexcPrivateRest<MexcAccountInfo>({
    method: 'GET',
    path: '/api/v3/account',
  });

  const out: Balances = {};
  for (const row of result.balances ?? []) {
    const asset = String(row.asset ?? '');
    if (!asset) continue;
    out[asset] = Number(row.free ?? 0);
  }
  return out;
}

async function createListenKey(): Promise<string> {
  const result = await mexcPrivateRest<MexcListenKeyResponse>({
    method: 'POST',
    path: '/api/v3/userDataStream',
  });
  const nextListenKey = String(result.listenKey ?? '');
  if (!nextListenKey) {
    throw new Error('mexc createListenKey returned empty listenKey');
  }
  return nextListenKey;
}

async function keepAliveListenKey(): Promise<void> {
  if (!listenKey) {
    throw new Error('mexc listenKey missing');
  }
  await mexcPrivateRest<MexcListenKeyResponse>({
    method: 'PUT',
    path: '/api/v3/userDataStream',
    params: { listenKey },
  });
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

function startListenKeyKeepAliveLoop(): void {
  if (listenKeyKeepAliveTmr) return;
  listenKeyKeepAliveTmr = setInterval(() => {
    keepAliveListenKey()
      .then(() => {
        log.debug({}, 'mexc listenKey keepalive ok');
      })
      .catch((err: unknown) => {
        log.warn({ err }, 'mexc listenKey keepalive failed');
      });
  }, LISTEN_KEY_KEEPALIVE_MS);
  listenKeyKeepAliveTmr.unref?.();
}

function handleUserDataStream(msgObj: MexcUserDataMsg): void {
  if (!msgObj.privateDeals || !msgObj.symbol) {
    return;
  }
  const canonSym = getCanonFromOderSym(msgObj.symbol, ExchangeIds.mexc);
  if (!canonSym) {
    log.warn({ msgObj }, 'mexc private order symbol mapping missing');
    return;
  }
  const r = msgObj.privateDeals;
  const status = OrderStates.FILLED; // annahme nur gefuellte orders werden geschickt
  // clearOrderChannelTimeout(ref);
  const side = r.tradeType === 1 ? OrderSides.BUY : OrderSides.SELL;
  const executedQty = Number(r.quantity);
  const cumQuoteQty = Number(r.amount);

  // fees ermitteln
  const feeAmount = Number(r.feeAmount);
  const feeCurrency = r.feeCurrency;
  const feeAssetPrice = getAssetPrice(ExchangeIds.bitget, 'MX'); // 15 min genauen preis holen
  let feeUsd = 0;
  if (feeAssetPrice == null) {
    log.warn({ currency: 'MX' }, 'missing cached asset price');
  } else {
    feeUsd = feeAssetPrice * feeAmount;
  }
  updateBalancesFromOrderData({
    side: r.tradeType === 1 ? OrderSides.BUY : OrderSides.SELL,
    baseAsset: getEx(canonSym, ExchangeIds.mexc)!.base,
    quoteAsset: getEx(canonSym, ExchangeIds.mexc)!.quote,
    executedQty,
    cummulativeQuoteQty: cumQuoteQty,
  });
  busRef.emit('trade:order_result', {
    exchange: ExchangeIds.mexc,
    symbol: msgObj.symbol, // order key, nicht canon !!!
    status,
    side,
    orderId: String(r.orderId),
    clientOrderId: r.clientOrderId,
    transactTime: Number(r.time),
    executedQty,
    cummulativeQuoteQty: cumQuoteQty,
    priceVwap: Number(r.price),
    fee_amount: feeAmount,
    fee_currency: feeCurrency,
    fee_usd: feeUsd,
  });
}

/**
 * Ablauf bei mexc: 
 *   1. listen key erzeugen mit http post
 *   2. websocket user data stream subscriben mit url die listen key erhaelt
 *   3. wenn orders per http post abgesetzt werden kommt ein ws user data stream event.
 *      dieser wird geparsed und per bus event 'trade:order_result' zurueck an den executor
 *      kommuniziert
 * 
 * - listen key muss alle 30 min erneuert werden
 * - ws verbindung ist max 24 h gueltig
 * @param _cfg 
 * @param deps 
 * @returns 
 */
async function init(_cfg: AppConfig, deps?: { bus?: any }): Promise<void> {
  busRef = deps?.bus ?? appBus;
  if (openPromise) {
    await openPromise;
    if (!balancesLoaded) {
      balances = await fetchBalances();
      balancesLoaded = true;
    }
    return;
  }
  if (!process.env.MEXC_API_KEY || !process.env.MEXC_API_SECRET) {
    throw new Error('Missing MEXC API credentials');
  }
  listenKey = await createListenKey();
  openPromise = new Promise<void>((res, rej) => {
    openResolve = res;
    openReject = rej;
  });
  const exState = getExState();
  const url = `wss://wbs-api.mexc.com/ws?listenKey=${encodeURIComponent(listenKey)}`;

  mgr = createReconnectWS({
    name: 'mexc-user-data-ws',
    log,
    staleTimeoutMs: null,
    heartbeatIntervalMs: 20_000,
    heartbeatMessageFactory: () => ({ method: 'PING' }),

    connect: () => {
      const ws = new WebSocket(url);
      wsRef = ws;
      return ws;
    },

    onOpen: async (ws: WebSocket) => {
      wsRef = ws;
      exState.onWsState('mexc-user-data-ws', WS_STATE.OPEN);
      log.debug({ url }, 'mexc user-data ws connected');
      try {
        ws.send(JSON.stringify({
          method: 'SUBSCRIPTION',
          params: ['spot@private.deals.v3.api.pb'],
        }));
        if (openResolve) {
          openResolve();
          openResolve = null;
          openReject = null;
        }
      } catch (err) {
        log.error({ err }, 'mexc user-data subscribe failed');
        openReject?.(err);
      }
    },

    onMessage: (msg: Buffer) => {
      exState.onWsMessage('mexc-user-data-ws');
      const raw = msg.toString();
      if (raw === 'pong') return;
      let parsed: any;
      try {
        parsed = JSON.parse(raw) as MexcUserDataMsg;
      } catch {
        log.debug({ raw }, 'mexc user-data ws message');
        return;
      }
      if (parsed.msg === 'PONG') {
        return;
      } else if (parsed.channel === 'spot@private.deals.v3.api.pb') {
        handleUserDataStream(parsed);
        return;
      }
      log.debug({ parsed }, 'mexc user-data ws message');
    },

    onReconnect: () => {
      exState.onWsReconnect('mexc-user-data-ws');
    },

    onClose: (code: number, reason: string) => {
      exState.onWsState('mexc-user-data-ws', WS_STATE.CLOSED);
      wsRef = null;
      openReject?.(new Error(`mexc ws closed during init code=${code} reason=${reason || ''}`));
    },

    onError: (err: Error) => {
      exState.onWsError('mexc-user-data-ws', err);
      openReject?.(err);
    },
  });

  mgr.start();
  await openPromise;

  balances = await fetchBalances();
  balancesLoaded = true;
  initialized = true;
  startBalanceRefreshLoop();
  startListenKeyKeepAliveLoop();
}

function isReady(): boolean {
  return initialized && wsRef !== null && wsRef.readyState === WebSocket.OPEN;
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
  if (!isReady()) throw new Error('mexc adapter not ready');

  const params: Record<string, string | number | undefined> = {
    symbol: orderParams.symbol,
    side: orderParams.side,
    type: orderParams.type,
    price: orderParams.price !== undefined ? String(orderParams.price) : undefined,
    newClientOrderId: orderParams.orderId,
  };
  if (orderParams.type === OrderTypes.MARKET && orderParams.side === OrderSides.BUY && orderParams.q !== undefined) {
    params.quoteOrderQty = String(orderParams.q);
  } else {
    params.quantity = String(orderParams.quantity);
  }
  const path = '/api/v3/order';
  log.debug({ params }, 'ORDER!!!!');

  let response: MexcNewOrderResponse | Record<string, never>;
  try {
    response = await mexcPrivateRest<MexcNewOrderResponse | Record<string, never>>({
      method: 'POST',
      path,
      params,
    });
  } catch (err) {
    log.error({ err, params, path }, 'mexc placeOrder failed');
    throw err;
  }
  log.debug({ params, rawOrderResponse: response }, 'placeOrder raw response');
}

async function cancelOrder(p: CancelOrderParams): Promise<void> {
  if (!isReady()) throw new Error('mexc adapter not ready');

  const params: Record<string, string | number | undefined> = {
    symbol: p.symbol,
  };

  if (p.orderId !== undefined) {
    const v = String(p.orderId);
    if (/^\d+$/.test(v)) {
      params.orderId = v;
    } else {
      params.origClientOrderId = v;
    }
  }

  let response: MexcCancelOrderResponse;
  try {
    response = await mexcPrivateRest<MexcCancelOrderResponse>({
      method: 'DELETE',
      path: '/api/v3/order',
      params,
    });
  } catch (err) {
    log.error({ err, params }, 'mexc cancelOrder failed');
    throw err;
  }
}

// TODO(mexc): echte User-Data-WS-Anbindung ergaenzen, sobald ListenKey / Protobuf
// Entscheidung und Konfiguration im Projekt stehen. Bis dahin bildet dieser
// Entwurf nur den Executor-Adapter mit signierten REST-Orderpfaden ab.
export const adapter: ExecutorAdapter = {
  init,
  isReady,
  getBalances,
  placeOrder,
  cancelOrder,
};
