/**
 * gate logged einmal ein und kann dann ohne einzel signatur
 * orders schicken.
 */
import crypto from 'crypto';
import WebSocket from 'ws';

import { getLogger } from '../../common/logger';
const log = getLogger('executor').child({ exchange: 'gate' });

import { createReconnectWS } from '../../common/ws_reconnect';
import { getExState } from '../../common/exchange_state';
import { WS_STATE } from '../../common/constants';
import { makeClientId } from '../../common/util';
import { getAssetPrice } from '../../common/symbolinfo_price';

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
import { OrderSides, ExchangeIds } from '../../types/common';
import type { ReconnectDelayOverrideArgs } from '../../types/ws_reconnect';

type GateSpotAccount = { currency: string; available: string; locked: string };

type GatePlaceOrderResult = {
  id: string;
  text: string;
  create_time_ms: number;
  status: string;
  currency_pair: string;
  avg_deal_price: string;
  filled_amount: string;
  filled_total: string;
  fee: string;
  fee_currency: string;
  gt_fee: string;
  slippage?: string;
};

type GateCancelOrderResult = {
  id: string;
  text: string;
  status: string;
  currency_pair: string;
  create_time_ms: number;
};

type GateTickerRow = {
  currency_pair?: string;
  last?: string; // letzter Preis
};

function sha512Hex(data: string): string {
  return crypto.createHash('sha512').update(data).digest('hex');
}

function hmacSha512Hex(secret: string, data: string): string {
  return crypto.createHmac('sha512', secret).update(data).digest('hex');
}

function makeWsSignature(opts: {
  secret: string;
  channel: string;
  reqParam: string;
  timestampSec: number;
}): string {
  const key = `api\n${opts.channel}\n${opts.reqParam}\n${opts.timestampSec}`;
  return hmacSha512Hex(opts.secret, key);
}

function gateRestHeaders(opts: {
  apiKey: string;
  apiSecret: string;
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  prefix: string;
  path: string;
  query: string;
  body: string;
  timestampSec?: number;
}) {
  const ts = opts.timestampSec ?? Math.floor(Date.now() / 1000);
  const bodyHash = sha512Hex(opts.body ?? '');
  const signStr = `${opts.method}\n${opts.prefix}${opts.path}\n${opts.query}\n${bodyHash}\n${ts}`;
  const sign = hmacSha512Hex(opts.apiSecret, signStr);

  return {
    KEY: opts.apiKey,
    Timestamp: String(ts),
    SIGN: sign,
  };
}

/**
 * Ergaenzt Prefix 't-' (gate-spezifisch)
 */
function idToGateText(orderId?: string): string {
  if (!orderId) return '';
  return `t-${orderId}`;
}

/**
 * Entfernt 't-' (gate-spezifisch)
 */
function idFromGateText(text?: string): string {
  if (!text) return '';
  if (!text.startsWith('t-')) return text;
  return text.slice(2);
}

let mgr: ReturnType<typeof createReconnectWS> | null = null;
let wsRef: WebSocket | null = null;
const pending: Map<string, PendingEntry> = new Map();
const apiKey = process.env.GATE_API_KEY!;
const apiSecret = process.env.GATE_API_SECRET!;
let balances: Balances = {};
let balancesLoaded = false;
let isLoggedIn = false;
const BALANCE_REFRESH_MS = 15 * 60 * 1000; // [ms] 15 min

function makeGateWsError(message: string, context: Record<string, unknown>): Error {
  const err = new Error(message) as Error & { context?: Record<string, unknown> };
  err.context = context;
  return err;
}

function sendFrame<T>(channel: string, payload: Record<string, unknown>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<T> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`gate ws not open (channel=${channel})`));
  }
  const reqId = String(payload.req_id ?? makeClientId());
  const frame = {
    time: Math.floor(Date.now() / 1000),
    channel,
    event: 'api',
    payload: {
      ...payload,
      req_id: reqId,
    },
  };
  // log.debug({frame}, 'sendFrame');
  return new Promise<T>((resolve, reject) => {
    const tmr = setTimeout(() => {
      pending.delete(reqId);
      reject(makeGateWsError(`gate ws timeout channel=${channel} req_id=${reqId}`, {
        channel,
        reqId,
        payload,
      }));
    }, timeoutMs);
    pending.set(reqId, {
      resolve,
      reject,
      tmr,
      requestContext: { method: channel, params: payload },
    });
    try {
      wsRef?.send(JSON.stringify(frame));
    } catch (e) {
      clearTimeout(tmr);
      pending.delete(reqId);
      log.error({ err: e, channel, reqId, payload, frame }, 'gate ws-api send failed');
      reject(e);
    }
  });
}

function sendReq<T>(channel: string, reqParam: Record<string, unknown>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<T> {
  return sendFrame<T>(channel, { req_param: reqParam }, { timeoutMs });
}

function makeLoginPayload() {
  const nowMs = Date.now();
  const ts = Math.floor(nowMs / 1000);
  return {
    api_key: apiKey,
    timestamp: String(ts),
    // Gate login: req_param is always an empty string for signature calculation.
    signature: makeWsSignature({
      secret: apiSecret,
      channel: 'spot.login',
      reqParam: '',
      timestampSec: ts,
    }),
    req_id: `${nowMs}-1`
  };
}

async function loginWs(): Promise<void> {
  const payload = makeLoginPayload();
  // log.debug({payload}, 'login');
  await sendFrame<Record<string, unknown>>('spot.login', payload, { timeoutMs: 10_000 });
  isLoggedIn = true;
}

function rejectAllPending(err: unknown): void {
  for (const [id, p] of pending.entries()) {
    clearTimeout(p.tmr);
    p.reject(err);
    pending.delete(id);
  }
}

let openResolve: (() => void) | null = null;
let openReject: ((err: unknown) => void) | null = null;
let openPromise: Promise<void> | undefined;
let balanceRefreshTmr: NodeJS.Timeout | null = null;

async function init(cfg: AppConfig): Promise<void> {
  if (openPromise) { // should not happen
    await openPromise;
    
    if (!balancesLoaded) {
      balances = await fetchBalances();
      balancesLoaded = true;
    }
    return;
  }

  if (!apiKey || !apiSecret) {
    throw new Error('Missing Gate API credentials');
  }

  openPromise = new Promise<void>((res, rej) => {
    openResolve = res;
    openReject = rej;
  });

  const exState = getExState();
  // const url = 'wss://ws-testnet.gate.com/v4/ws/spot';
  const url = 'wss://api.gateio.ws/ws/v4/';

  mgr = createReconnectWS({
    name: 'gate-ws-api',
    log,
    staleTimeoutMs: null,
    heartbeatIntervalMs: 20000,

    connect: () => {
      const ws = new WebSocket(url);
      wsRef = ws;
      return ws;
    },

    onOpen: async (ws: WebSocket) => {
      wsRef = ws;
      isLoggedIn = false;
      exState.onWsState('gate-ws-api', WS_STATE.OPEN);
      log.debug({ url }, 'ws-api connected');

      try {
        await loginWs();
        log.info({}, 'log in successful');
        if (openResolve) {
          openResolve();
          openResolve = null;
          openReject = null;
        }
      } catch (err: any) {
        log.error({ err }, 'ws-api login failed');
        openReject?.(err);
      }
    },

    onMessage: (msg: Buffer) => {
      exState.onWsMessage('gate-ws-api');
      let parsed: any;
      try {
        parsed = JSON.parse(msg.toString());
        // log.debug({ msg: parsed }, 'onMessage');
      } catch (e) {
        log.error({ err: e }, 'gate ws-api message parse error');
        return;
      }

      const reqId = parsed?.request_id ? String(parsed.request_id) : null;
      if (!reqId) return;
      if (parsed?.ack === true) return;

      const p = pending.get(reqId);
      if (!p) return;

      clearTimeout(p.tmr);
      pending.delete(reqId);

      const status = Number(parsed?.header?.status ?? 0);
      const errs = parsed?.data?.errs;
      if (status !== 200 || errs) {
        const label = errs?.label ?? 'GATE_WS_ERROR';
        const message = errs?.message ?? 'unknown error';
        log.error({
          reqId,
          status,
          channel: p.requestContext?.method,
          payload: p.requestContext?.params,
          rawErrorResponse: parsed,
        }, 'gate ws-api request failed');
        const e = makeGateWsError(`${label}: ${message}`, {
          status,
          channel: p.requestContext?.method,
          payload: p.requestContext?.params,
          rawErrorResponse: parsed,
        });
        p.reject(e);
        return;
      }

      p.resolve(parsed?.data?.result);
    },

    onReconnect: () => {
      exState.onWsReconnect('gate-ws-api');
    },

    onClose: (code: number, reason: string) => {
      exState.onWsState('gate-ws-api', WS_STATE.CLOSED);
      wsRef = null;
      isLoggedIn = false;
      rejectAllPending(new Error(`gate ws closed code=${code} reason=${reason || ''}`));
      openReject?.(new Error('ws closed during init'));
    },

    onError: (err: Error) => {
      exState.onWsError('gate-ws-api', err);
      isLoggedIn = false;
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

  if (!balancesLoaded) {
    balances = await fetchBalances();
    balancesLoaded = true;
  }
  startBalanceRefreshLoop();
}

/**
 * Holt Bestaende via REST
 */
async function fetchBalances(): Promise<Balances> {
  const host = process.env.GATE_REST_HOST ?? 'https://api.gateio.ws';
  const prefix = '/api/v4';
  const path = '/spot/accounts';
  const query = '';
  const body = '';

  const headers = {
    Accept: 'application/json',
    ...gateRestHeaders({ apiKey, apiSecret, method: 'GET', prefix, path, query, body }),
  };

  const url = `${host}${prefix}${path}${query ? `?${query}` : ''}`;
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    log.error({ status: res.status, text: await res.text() }, 'gate GET /spot/accounts failed');
  }

  const rows = (await res.json()) as GateSpotAccount[];
  // log.debug({ rows }, 'gate getBalances response');
  const out: Record<string, number> = {};
  for (const r of rows) out[r.currency] = Number(r.available ?? 0);
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

async function subscribeUserData() {
  throw new Error('subscribeUserData not implemented');
}

async function placeOrder(test: boolean, orderParams: PlaceOrderParams): Promise<CommonOrderResult> {
  if (!isLoggedIn) {
    throw new Error('gate ws-api not logged in');
  }
  if (!orderParams.symbol) {
    throw new Error('gate placeOrder requires symbol');
  }

  const reqParam: Record<string, unknown> = {
    currency_pair: orderParams.symbol,
    side: String(orderParams.side).toLowerCase(),
    type: String(orderParams.type).toLowerCase(),
    text: idToGateText(orderParams.orderId),
    action_mode: 'FULL',
    time_in_force: 'fok'
  };
  if (orderParams.side === OrderSides.BUY) {
    if (orderParams.q === undefined) {
      throw new Error('gate market buy requires q (quote amount)');
    }
    reqParam.amount = String(orderParams.q);
  } else if (orderParams.side === OrderSides.SELL) {
    reqParam.amount = String(orderParams.quantity);
  }
  log.debug({reqParam}, 'ORDER!!!!');
  let r: GatePlaceOrderResult;
  try {
    r = await sendReq<GatePlaceOrderResult>('spot.order_place', reqParam, { timeoutMs: 10_000 });
  } catch (err) {
    log.error({ err, reqParam }, 'gate placeOrder failed');
    throw err;
  }
  log.debug({ reqParam, rawOrderResponse: r }, 'placeOrder raw response');

  // [2026-02-26 15:34:32.648 +0100] DEBUG (executor): placeOrder raw response
  //   exchange: "gate"
  //   reqParam: {
  //     "currency_pair": "AXS_USDT",
  //     "side": "buy",
  //     "type": "market",
  //     "text": "t-123456789",
  //     "action_mode": "FULL",
  //     "time_in_force": "fok",
  //     "amount": "13.6"
  //   }
  //   rawOrderResponse: {
  //     "id": "1021176225755",
  //     "text": "t-123456789",
  //     "amend_text": "-",
  //     "create_time": "1772116472",
  //     "update_time": "1772116472",
  //     "create_time_ms": 1772116472554,
  //     "update_time_ms": 1772116472555,
  //     "status": "closed",
  //     "currency_pair": "AXS_USDT",
  //     "type": "market",
  //     "account": "spot",
  //     "side": "buy",
  //     "amount": "13.6",
  //     "price": "0",
  //     "time_in_force": "fok",
  //     "iceberg": "0",
  //     "left": "0.006",
  //     "filled_amount": "10",
  //     "fill_price": "13.594",
  //     "filled_total": "13.594",
  //     "avg_deal_price": "1.3594",
  //     "fee": "0",
  //     "fee_currency": "AXS",
  //     "point_fee": "0",
  //     "gt_fee": "0.00171113286713286713",
  //     "gt_maker_fee": "0",
  //     "gt_taker_fee": "0.0009",
  //     "gt_discount": true,
  //     "rebated_fee": "0",
  //     "rebated_fee_currency": "USDT",
  //     "finish_as": "filled"
  //   }

  const cumQuote : number = Number(r.filled_total);
  const totalCommission = Number(r.gt_fee);
  let feeUsd = 0.0;
  if (totalCommission > 0.0) {
    const feeAssetPrice = getAssetPrice(ExchangeIds.gate, 'GT');
    if (feeAssetPrice == null) {
      log.warn({ currency: 'GT' }, 'missing cached asset price');
    } else {
      feeUsd = feeAssetPrice * totalCommission;
    }
  } else { // no gt_fee ?
    feeUsd = Number(r.fee); // assume usd fee
    if (feeUsd <= 1e-6) {
      log.warn({currency:r.fee_currency}, 'unknown fee currency');
      feeUsd = 0.0;
    }
  }
  const out : CommonOrderResult = {
    exchange: ExchangeIds.gate,
    symbol: r.currency_pair,
    status: r.status === 'closed' ? OrderStates.FILLED : OrderStates.UNKNOWN,
    orderId: r.id,
    clientOrderId: idFromGateText(r.text),
    transactTime: Number(r.create_time_ms),
    executedQty: Number(r.filled_amount),
    cummulativeQuoteQty: cumQuote,
    priceVwap: Number(r.avg_deal_price),
    slippage: Number(r.slippage),
    fee_amount: totalCommission,
    fee_currency: r.fee_currency,
    fee_usd: feeUsd,
  };
  return out;
}

async function cancelOrder(p: CancelOrderParams): Promise<CommonOrderResult> {
  if (!isLoggedIn) {
    throw new Error('gate ws-api not logged in');
  }
  if (!p.symbol) {
    throw new Error('gate cancelOrder requires symbol');
  }

  const reqParam: Record<string, unknown> = {
    currency_pair: p.symbol,
  };
  if (p.orderId !== undefined) {
    reqParam.order_id = idToGateText(String(p.orderId));
  }

  let r: GateCancelOrderResult;
  try {
    r = await sendReq<GateCancelOrderResult>('spot.order_cancel', reqParam, { timeoutMs: 10_000 });
  } catch (err) {
    log.error({ err, reqParam }, 'gate cancelOrder failed');
    throw err;
  }

  return {
    exchange: ExchangeIds.gate,
    symbol: r.currency_pair,
    status: r.status === 'cancelled' ? OrderStates.CANCELLED : OrderStates.UNKNOWN,
    orderId: r.id,
    clientOrderId: r.text,
    transactTime: r.create_time_ms,
    executedQty: 0,
    cummulativeQuoteQty: 0,
    priceVwap: 0,
    fee_amount: 0,
    fee_currency: '',
    fee_usd: 0,
  };
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

export const adapter: ExecutorAdapter = {
  init,
  isReady,
  getBalances,
  updateBalancesFromOrderData,
  placeOrder,
  cancelOrder,
};
