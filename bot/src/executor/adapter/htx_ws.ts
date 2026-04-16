import crypto from 'crypto';
import WebSocket from 'ws';

import { getLogger } from '../../common/logger';
const log = getLogger('executor').child({ exchange: 'htx' });

import { createReconnectWS } from '../../common/ws_reconnect';
import { getExState } from '../../common/exchange_state';
import { WS_STATE } from '../../common/constants';
import { makeClientId } from '../../common/util';
import { compileStepMeta, floorByStepMeta, getCanonFromOderSym, getEx } from '../../common/symbolinfo';
import { getAssetPrice } from '../../common/symbolinfo_price';
import appBus from '../../bus';

import {
  type Balances,
  type CancelOrderParams,
  type ExecutorAdapter,
  type OrderState,
  type PendingEntry,
  type PlaceOrderParams,
  type UpdateBalancesParams,
  OrderStates,
} from '../../types/executor';
import type { AppConfig } from '../../types/config';
import { ExchangeIds, OrderSides, OrderTypes } from '../../types/common';
import type { ReconnectDelayOverrideArgs } from '../../types/ws_reconnect';

type HtxAccountRow = {
  id?: number | string;
  type?: string;
  state?: string;
};

type HtxBalanceRow = {
  currency?: string;
  type?: string;
  balance?: string;
};

type HtxAccountBalanceResponse = {
  status?: string;
  data?: {
    list?: HtxBalanceRow[];
  };
};

type HtxRestResponse<T> = {
  status?: string;
  data?: T;
  ['err-code']?: string;
  ['err-msg']?: string;
};

type HtxWsResponse<T = unknown> = {
  action?: string;
  ch?: string;
  code?: number;
  message?: string;
  cid?: string;
  data?: T;
};

type HtxPlaceOrderResult = {
  orderId?: number | string;
  orderIdStr?: string;
  clientOrderId?: string;
};

type HtxTradeClearingRow = {
  eventType?: 'trade' | 'cancellation' | string;
  symbol?: string;
  orderId?: number | string;
  tradePrice?: string;
  tradeVolume?: string;
  orderSide?: 'buy' | 'sell' | string;
  tradeId?: number | string;
  tradeTime?: number;
  transactFee?: string;
  feeCurrency?: string;
  feeDeduct?: string;
  feeDeductType?: string;
  accountId?: number | string;
  orderPrice?: string;
  orderSize?: string;
  orderValue?: string;
  clientOrderId?: string;
  orderCreateTime?: number;
  orderStatus?: string;
};

const apiKey = process.env.HTX_API_KEY!;
const apiSecret = process.env.HTX_API_SECRET!;
const restHost = process.env.HTX_REST_HOST ?? 'https://api-aws.huobi.pro';
const wsUrl = process.env.HTX_WS_PRIVATE_URL ?? 'wss://api-aws.huobi.pro/ws/v2';
const wsHost = new URL(wsUrl).host;
const wsPath = new URL(wsUrl).pathname;

let accountId = process.env.HTX_ACCOUNT_ID ?? '';
let mgr: ReturnType<typeof createReconnectWS> | null = null;
let wsRef: WebSocket | null = null;
let busRef: any;
let balances: Balances = {};
let balancesLoaded = false;
let isLoggedIn = false;
let openPromise: Promise<void> | undefined;
let openResolve: (() => void) | null = null;
let openReject: ((err: unknown) => void) | null = null;
let balanceRefreshTmr: NodeJS.Timeout | null = null;
const pending: Map<string, PendingEntry> = new Map();
const orderAccum: Map<string, {
  exchangeSymbol: string;
  side: 'BUY' | 'SELL';
  clientOrderId: string;
  orderId: string | number;
  transactTime: number;
  executedQty: number;
  cummulativeQuoteQty: number;
  feeAmount: number;
  feeCurrency: string;
}> = new Map();
const BALANCE_REFRESH_MS = 15 * 60 * 1000;

function hmacSha256Base64(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64');
}

function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildCanonicalQuery(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${rfc3986Encode(key)}=${rfc3986Encode(String(value))}`)
    .join('&');
}

function htxTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '');
}

function makeSignedQuery(opts: {
  method: 'GET' | 'POST';
  host: string;
  path: string;
  extra?: Record<string, string | number | undefined>;
  signatureVersion?: '2' | '2.1';
}): string {
  const params = {
    AccessKeyId: apiKey,
    SignatureMethod: 'HmacSHA256',
    SignatureVersion: opts.signatureVersion ?? '2',
    Timestamp: htxTimestamp(),
    ...(opts.extra ?? {}),
  };
  const canonicalQuery = buildCanonicalQuery(params);
  const payload = `${opts.method}\n${opts.host.toLowerCase()}\n${opts.path}\n${canonicalQuery}`;
  const signature = hmacSha256Base64(apiSecret, payload);
  return `${canonicalQuery}&Signature=${rfc3986Encode(signature)}`;
}

function makeHtxError(message: string, context: Record<string, unknown>): Error {
  const err = new Error(message) as Error & { context?: Record<string, unknown> };
  err.context = context;
  return err;
}

function getHtxQuoteAmountString(symbol: string, q: number): string {
  const canonSym = getCanonFromOderSym(symbol, ExchangeIds.htx);
  const exInfo = canonSym ? getEx(canonSym, ExchangeIds.htx) : null;
  const meta = compileStepMeta(exInfo?.rules?.priceTick ?? 0, 8);
  return floorByStepMeta(q, meta).qStr.replace(/\.?0+$/, '');
}

function getHtxBaseAmountString(symbol: string, quantity: number): string {
  const canonSym = getCanonFromOderSym(symbol, ExchangeIds.htx);
  const exInfo = canonSym ? getEx(canonSym, ExchangeIds.htx) : null;
  return floorByStepMeta(quantity, exInfo?.rules?.qty ?? compileStepMeta(undefined, 8)).qStr.replace(/\.?0+$/, '');
}

function htxOrderType(side: string, type: string): string {
  const sidePart = side === OrderSides.BUY ? 'buy' : 'sell';
  if (type === OrderTypes.MARKET) return `${sidePart}-market`;
  if (type === OrderTypes.LIMIT) return `${sidePart}-limit`;
  return `${sidePart}-${String(type).toLowerCase()}`;
}

async function htxPrivateRest<T>(opts: {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}): Promise<T> {
  const host = new URL(restHost).host;
  const query = makeSignedQuery({ method: opts.method, host, path: opts.path, signatureVersion: '2' });
  const url = `${restHost}${opts.path}?${query}`;
  const res = await fetch(url, {
    method: opts.method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = text;
  }
  if (!res.ok || json?.status === 'error') {
    throw makeHtxError(`htx rest error ${opts.method} ${opts.path}: ${json?.['err-msg'] ?? `status=${res.status}`}`, {
      method: opts.method,
      path: opts.path,
      status: res.status,
      rawErrorResponse: json,
    });
  }
  return json as T;
}

async function resolveAccountId(): Promise<string> {
  if (accountId) return accountId;
  const result = await htxPrivateRest<HtxRestResponse<HtxAccountRow[]>>({ method: 'GET', path: '/v1/account/accounts' });
  const spot = (result.data ?? []).find((row) => row.type === 'spot' && row.state !== 'locked')
    ?? (result.data ?? []).find((row) => row.type === 'spot');
  const id = String(spot?.id ?? '');
  if (!id) throw new Error('htx spot account id not found');
  accountId = id;
  return accountId;
}

async function fetchBalances(): Promise<Balances> {
  const id = await resolveAccountId();
  const result = await htxPrivateRest<HtxAccountBalanceResponse>({
    method: 'GET',
    path: `/v1/account/accounts/${id}/balance`,
  });
  const out: Balances = {};
  for (const row of result.data?.list ?? []) {
    if (row.type !== 'trade') continue;
    const asset = String(row.currency ?? '').toUpperCase();
    if (!asset) continue;
    out[asset] = Number(row.balance ?? 0);
  }
  return out;
}

function sendWsReq<T>(ch: string, data: Record<string, unknown>, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<T> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`htx ws not open (ch=${ch})`));
  }
  const cid = String(data.clientOrderId ?? makeClientId());
  const frame = {
    action: 'req',
    ch,
    cid,
    data,
  };

  return new Promise<T>((resolve, reject) => {
    const tmr = setTimeout(() => {
      pending.delete(cid);
      reject(makeHtxError(`htx ws timeout ch=${ch} cid=${cid}`, { ch, cid, data }));
    }, timeoutMs);
    pending.set(cid, {
      resolve,
      reject,
      tmr,
      requestContext: { method: ch, params: data },
    });
    try {
      wsRef?.send(JSON.stringify(frame));
    } catch (err) {
      clearTimeout(tmr);
      pending.delete(cid);
      reject(err);
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

function findSinglePendingByChannel(ch?: string): [string, PendingEntry] | null {
  if (!ch) return null;
  const matches = Array.from(pending.entries()).filter(([, entry]) => entry.requestContext?.method === ch);
  return matches.length === 1 ? matches[0] : null;
}

function makeAuthFrame(): Record<string, unknown> {
  const params = {
    authType: 'api',
    accessKey: apiKey,
    signatureMethod: 'HmacSHA256',
    signatureVersion: '2.1',
    timestamp: htxTimestamp(),
  };
  const canonicalQuery = buildCanonicalQuery({
    accessKey: params.accessKey,
    signatureMethod: params.signatureMethod,
    signatureVersion: params.signatureVersion,
    timestamp: params.timestamp,
  });
  const payload = `GET\n${wsHost.toLowerCase()}\n${wsPath}\n${canonicalQuery}`;
  return {
    action: 'req',
    ch: 'auth',
    params: {
      ...params,
      signature: hmacSha256Base64(apiSecret, payload),
    },
  };
}

async function loginWs(): Promise<void> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    throw new Error('htx ws not open');
  }
  const frame = makeAuthFrame();
  await new Promise<void>((resolve, reject) => {
    const cid = 'auth';
    const tmr = setTimeout(() => {
      pending.delete(cid);
      reject(new Error('htx auth timeout'));
    }, 10_000);
    pending.set(cid, {
      resolve: () => resolve(),
      reject,
      tmr,
      requestContext: { method: 'auth', params: frame as Record<string, unknown> },
    });
    wsRef?.send(JSON.stringify(frame));
  });
  isLoggedIn = true;
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
  if (!Number.isFinite(baseDelta) || !Number.isFinite(quoteDelta)) return;

  const base = params.baseAsset;
  const quote = params.quoteAsset;
  balances[base] = balances[base] ?? 0;
  balances[quote] = balances[quote] ?? 0;

  if (params.side === OrderSides.BUY) {
    balances[quote] -= quoteDelta;
    balances[base] += baseDelta;
  } else if (params.side === OrderSides.SELL) {
    balances[quote] += quoteDelta;
    balances[base] -= baseDelta;
  }
}

function subscribeUserData(cfg: AppConfig): void {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    throw new Error('htx ws not open');
  }
  const symbols = cfg.symbols
    .map((sym) => getEx(sym, ExchangeIds.htx)?.mdKey)
    .filter((sym): sym is string => Boolean(sym));
  const subscribed = symbols.length > 0 ? symbols : ['*'];
  for (const symbol of subscribed) {
    wsRef.send(JSON.stringify({
      action: 'sub',
      ch: `trade.clearing#${symbol}#0`,
    }));
  }
  log.info({ symbols: subscribed.length }, 'htx private trade clearing subscribed');
}

function handleTradeDetails(msgObj: HtxWsResponse<HtxTradeClearingRow>): void {
  const row = msgObj.data;
  if (!row?.symbol) return;
  const canonSym = getCanonFromOderSym(row.symbol.toUpperCase(), ExchangeIds.htx);
  if (!canonSym) {
    log.warn({ row }, 'htx trade clearing symbol mapping missing');
    return;
  }

  const side = row.orderSide === 'buy' ? OrderSides.BUY : OrderSides.SELL;
  const orderId = row.orderId ?? '';
  const clientOrderId = String(row.clientOrderId ?? '');
  const key = clientOrderId || String(orderId);
  if (!key) return;

  if (row.eventType === 'cancellation') {
    busRef.emit('trade:order_result', {
      exchange: ExchangeIds.htx,
      symbol: row.symbol.toUpperCase(),
      status: OrderStates.CANCELLED,
      side,
      orderId,
      clientOrderId,
      transactTime: Number(row.tradeTime ?? row.orderCreateTime ?? Date.now()),
      executedQty: 0,
      cummulativeQuoteQty: 0,
      priceVwap: 0,
      fee_amount: 0,
      fee_currency: '',
      fee_usd: 0,
    });
    return;
  }
  if (row.eventType !== 'trade') return;

  const tradeQty = Number(row.tradeVolume ?? 0);
  const tradePrice = Number(row.tradePrice ?? 0);
  const quoteQty = tradeQty * tradePrice;
  const feeAmount = Number(row.transactFee ?? 0);
  const feeCurrency = String(row.feeCurrency ?? '').toUpperCase();

  const acc = orderAccum.get(key) ?? {
    exchangeSymbol: row.symbol.toUpperCase(),
    side,
    clientOrderId,
    orderId,
    transactTime: Number(row.tradeTime ?? Date.now()),
    executedQty: 0,
    cummulativeQuoteQty: 0,
    feeAmount: 0,
    feeCurrency,
  };
  acc.executedQty += Number.isFinite(tradeQty) ? tradeQty : 0;
  acc.cummulativeQuoteQty += Number.isFinite(quoteQty) ? quoteQty : 0;
  acc.feeAmount += Number.isFinite(feeAmount) ? feeAmount : 0;
  acc.feeCurrency = feeCurrency || acc.feeCurrency;
  acc.transactTime = Number(row.tradeTime ?? acc.transactTime);
  orderAccum.set(key, acc);

  let status: OrderState = OrderStates.UNKNOWN;
  if (row.orderStatus === 'filled') status = OrderStates.FILLED;
  else if (row.orderStatus === 'partial-filled') status = OrderStates.PARTIALLY_FILLED;
  if (status !== OrderStates.FILLED) return;

  let feeUsd = 0;
  if (acc.feeAmount > 0 && acc.feeCurrency) {
    const feeAssetPrice = getAssetPrice(ExchangeIds.htx, acc.feeCurrency);
    if (feeAssetPrice == null) {
      log.warn({ currency: acc.feeCurrency }, 'missing cached asset price');
    } else {
      feeUsd = feeAssetPrice * acc.feeAmount;
    }
  }

  updateBalancesFromOrderData({
    side,
    baseAsset: getEx(canonSym, ExchangeIds.htx)!.base,
    quoteAsset: getEx(canonSym, ExchangeIds.htx)!.quote,
    executedQty: acc.executedQty,
    cummulativeQuoteQty: acc.cummulativeQuoteQty,
  });

  busRef.emit('trade:order_result', {
    exchange: ExchangeIds.htx,
    symbol: acc.exchangeSymbol,
    status,
    side,
    orderId: acc.orderId,
    clientOrderId: acc.clientOrderId,
    transactTime: acc.transactTime,
    executedQty: acc.executedQty,
    cummulativeQuoteQty: acc.cummulativeQuoteQty,
    priceVwap: acc.executedQty > 0 ? acc.cummulativeQuoteQty / acc.executedQty : 0,
    fee_amount: acc.feeAmount,
    fee_currency: acc.feeCurrency,
    fee_usd: feeUsd,
  });
  orderAccum.delete(key);
}

function handleWsResponse(parsed: HtxWsResponse): void {
  if (parsed.action === 'ping') {
    wsRef?.send(JSON.stringify({ action: 'pong', data: parsed.data }));
    return;
  }
  if (parsed.action === 'push' && parsed.ch?.startsWith('trade.clearing#')) {
    handleTradeDetails(parsed as HtxWsResponse<HtxTradeClearingRow>);
    return;
  }
  if (parsed.action === 'sub') {
    if (parsed.code !== 200) {
      log.error({ parsed }, 'htx subscribe failed');
    } else {
      log.debug({ ch: parsed.ch }, 'htx private stream subscribed');
    }
    return;
  }

  const cid = parsed.cid ?? (parsed.ch === 'auth' ? 'auth' : null);
  const pendingEntry = cid ? pending.get(cid) ? [cid, pending.get(cid)!] as [string, PendingEntry] : null : findSinglePendingByChannel(parsed.ch);
  if (!pendingEntry) return;
  const [pendingId, p] = pendingEntry;
  clearTimeout(p.tmr);
  pending.delete(pendingId);

  if (parsed.code !== 200) {
    p.reject(makeHtxError(`htx ws request failed code=${parsed.code ?? 'unknown'} message=${parsed.message ?? ''}`, {
      rawErrorResponse: parsed,
      channel: parsed.ch,
      payload: p.requestContext?.params,
    }));
    return;
  }
  p.resolve(parsed.data);
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
  if (!apiKey || !apiSecret) {
    throw new Error('Missing HTX API credentials');
  }

  openPromise = new Promise<void>((resolve, reject) => {
    openResolve = resolve;
    openReject = reject;
  });
  const exState = getExState();

  mgr = createReconnectWS({
    name: 'htx-ws-api',
    log,
    staleTimeoutMs: null,
    heartbeatIntervalMs: 20_000,
    connect: () => {
      const ws = new WebSocket(wsUrl);
      wsRef = ws;
      return ws;
    },
    onOpen: async (ws) => {
      wsRef = ws;
      isLoggedIn = false;
      exState.onWsState('htx-ws-api', WS_STATE.OPEN);
      try {
        await loginWs();
        subscribeUserData(cfg);
        log.info({}, 'htx ws auth successful');
        openResolve?.();
        openResolve = null;
        openReject = null;
      } catch (err) {
        log.error({ err }, 'htx ws auth failed');
        openReject?.(err);
      }
    },
    onMessage: (msg) => {
      exState.onWsMessage('htx-ws-api');
      try {
        const parsed = JSON.parse(msg.toString()) as HtxWsResponse;
        handleWsResponse(parsed);
      } catch (err) {
        log.error({ err }, 'htx ws message parse error');
      }
    },
    onReconnect: () => exState.onWsReconnect('htx-ws-api'),
    onClose: (code, reason) => {
      exState.onWsState('htx-ws-api', WS_STATE.CLOSED);
      wsRef = null;
      isLoggedIn = false;
      rejectAllPending(new Error(`htx ws closed code=${code} reason=${reason || ''}`));
      openReject?.(new Error('htx ws closed during init'));
    },
    onError: (err) => {
      exState.onWsError('htx-ws-api', err);
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

async function placeOrder(orderParams: PlaceOrderParams): Promise<void> {
  if (!isLoggedIn) {
    throw new Error('htx ws-api not logged in');
  }
  const clientOrderId = String(orderParams.orderId ?? makeClientId());
  const data: Record<string, unknown> = {
    accountId: accountId || await resolveAccountId(),
    symbol: orderParams.symbol.toLowerCase(),
    type: htxOrderType(orderParams.side, orderParams.type),
    source: 'spot-api',
    clientOrderId,
  };
  if (orderParams.side === OrderSides.BUY && orderParams.type === OrderTypes.MARKET) {
    if (orderParams.q === undefined) throw new Error('htx market buy requires q (quote amount)');
    data.amount = getHtxQuoteAmountString(orderParams.symbol, orderParams.q);
  } else {
    data.amount = getHtxBaseAmountString(orderParams.symbol, orderParams.quantity);
  }
  if (orderParams.type === OrderTypes.LIMIT) {
    if (orderParams.price === undefined) throw new Error('htx limit order requires price');
    data.price = String(orderParams.price);
  }

  try {
    const response = await sendWsReq<HtxPlaceOrderResult>('order.place', data, { timeoutMs: 10_000 });
    log.debug({ data, rawOrderResponse: response }, 'htx placeOrder raw response');
  } catch (err) {
    log.error({ err, data }, 'htx placeOrder failed');
    throw err;
  }
}

async function cancelOrder(params: CancelOrderParams): Promise<void> {
  if (!isLoggedIn) {
    throw new Error('htx ws-api not logged in');
  }
  const data: Record<string, unknown> = {
    accountId: accountId || await resolveAccountId(),
  };
  if (params.orderId !== undefined) {
    data.orderId = String(params.orderId);
  } else {
    throw new Error('htx cancelOrder requires orderId');
  }
  try {
    await sendWsReq('order.cancel', data, { timeoutMs: 10_000 });
  } catch (err) {
    log.error({ err, data }, 'htx cancelOrder failed');
    throw err;
  }
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
      .catch((err) => log.warn({ err }, 'balance refresh failed'));
  }, BALANCE_REFRESH_MS);
  balanceRefreshTmr.unref?.();
}

export const adapter: ExecutorAdapter = {
  init,
  isReady,
  getBalances,
  placeOrder,
  cancelOrder,
};
