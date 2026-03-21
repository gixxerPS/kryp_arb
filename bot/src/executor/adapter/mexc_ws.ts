import crypto from 'crypto';

import { getLogger } from '../../common/logger';
const log = getLogger('executor').child({ exchange: 'mexc' });

import {
  type Balances,
  type CommonOrderResult,
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
  method: 'GET' | 'POST' | 'DELETE';
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
let balanceRefreshTmr: NodeJS.Timeout | null = null;
const BALANCE_REFRESH_MS = 15 * 60 * 1000;

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

async function init(_cfg: AppConfig): Promise<void> {
  if (initialized) {
    if (!balancesLoaded) {
      balances = await fetchBalances();
      balancesLoaded = true;
    }
    return;
  }

  if (!process.env.MEXC_API_KEY || !process.env.MEXC_API_SECRET) {
    throw new Error('Missing MEXC API credentials');
  }

  balances = await fetchBalances();
  balancesLoaded = true;
  initialized = true;
  startBalanceRefreshLoop();
}

function isReady(): boolean {
  return initialized;
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

  const path = test ? '/api/v3/order/test' : '/api/v3/order';
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

  if (test) {
    return {
      exchange: ExchangeIds.mexc,
      symbol: orderParams.symbol,
      status: OrderStates.UNKNOWN,
      orderId: orderParams.orderId ?? '',
      clientOrderId: orderParams.orderId,
      transactTime: Date.now(),
      executedQty: 0,
      cummulativeQuoteQty: 0,
      priceVwap: 0,
      fee_amount: 0,
      fee_currency: '',
      fee_usd: 0,
    };
  }

  const r = response as MexcNewOrderResponse;
  return {
    exchange: ExchangeIds.mexc,
    symbol: r.symbol,
    status: OrderStates.UNKNOWN,
    orderId: r.orderId,
    clientOrderId: orderParams.orderId,
    transactTime: Number(r.transactTime ?? Date.now()),
    executedQty: Number(r.origQty ?? 0),
    cummulativeQuoteQty: 0,
    priceVwap: Number(r.price ?? 0),
    fee_amount: 0,
    fee_currency: '',
    fee_usd: 0,
  };
}

async function cancelOrder(p: CancelOrderParams): Promise<CommonOrderResult> {
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

  return {
    exchange: ExchangeIds.mexc,
    symbol: response.symbol,
    status: response.status === 'CANCELED' ? OrderStates.CANCELLED : OrderStates.UNKNOWN,
    orderId: response.orderId,
    clientOrderId: response.origClientOrderId,
    transactTime: Date.now(),
    executedQty: Number(response.executedQty ?? 0),
    cummulativeQuoteQty: Number(response.cummulativeQuoteQty ?? 0),
    priceVwap: Number(response.price ?? 0),
    fee_amount: 0,
    fee_currency: '',
    fee_usd: 0,
  };
}

// TODO(mexc): echte User-Data-WS-Anbindung ergaenzen, sobald ListenKey / Protobuf
// Entscheidung und Konfiguration im Projekt stehen. Bis dahin bildet dieser
// Entwurf nur den Executor-Adapter mit signierten REST-Orderpfaden ab.
export const adapter: ExecutorAdapter = {
  init,
  isReady,
  getBalances,
  updateBalancesFromOrderData,
  placeOrder,
  cancelOrder,
};
