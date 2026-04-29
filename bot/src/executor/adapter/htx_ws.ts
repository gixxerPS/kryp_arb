import crypto from 'crypto';
import fs from 'fs';
import WebSocket from 'ws';

import { getLogger } from '../../common/logger';
const log = getLogger('executor').child({ exchange: 'htx' });

import { createReconnectWS } from '../../common/ws_reconnect';
import { getExState } from '../../common/exchange_state';
import { WS_STATE } from '../../common/constants';
import { makeClientId } from '../../common/util';
import { compileStepMeta, floorByStepMeta, getCanonFromOderSym, getEx } from '../../common/symbolinfo';
import { getAssetPrice } from '../../common/symbolinfo_price';
import { signEd25519Base64 } from '../../common/signing';
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
  execAmt?: string;
  remainAmt?: string;
  clientOrderId?: string;
  orderCreateTime?: number;
  orderStatus?: string;
};

type HtxOrderUpdateRow = {
  eventType?: 'creation' | 'trade' | 'cancellation' | string;
  symbol?: string;
  orderId?: number | string;
  orderSide?: 'buy' | 'sell' | string;
  orderType?: string;
  orderStatus?: string;
  orderSize?: string;
  orderValue?: string;
  execAmt?: string;
  remainAmt?: string;
  clientOrderId?: string;
  orderCreateTime?: number;
  tradeTime?: number;
  lastActTime?: number;
};

type HtxAuthMethod = 'HmacSHA256' | 'Ed25519';

const authMethod: HtxAuthMethod = process.env.HTX_AUTH_METHOD === 'HmacSHA256' ? 'HmacSHA256' : 'Ed25519';
const apiKey = authMethod === 'Ed25519'
  ? process.env.HTX_ED25519_ACCESS_KEY?.trim() ?? ''
  : process.env.HTX_API_KEY?.trim() ?? '';
const apiSecret = process.env.HTX_API_SECRET?.trim() ?? '';
const ed25519PrivateKeyFile = process.env.HTX_ED25519_PRIVATE_KEY_FILE;
const restHost = process.env.HTX_REST_HOST ?? 'https://api-aws.huobi.pro';
const wsUrl = process.env.HTX_WS_PRIVATE_URL ?? 'wss://api-aws.huobi.pro/ws/v2';
const wsHost = new URL(wsUrl).host;
const wsSignatureHost = (process.env.HTX_WS_SIGNATURE_HOST ?? wsHost).toLowerCase();
const wsPath = new URL(wsUrl).pathname;

let accountId = process.env.HTX_ACCOUNT_ID ?? '';
let mgr: ReturnType<typeof createReconnectWS> | null = null;
let wsRef: WebSocket | null = null;
let ed25519PrivateKeyPem = '';
let busRef: any;
let balances: Balances = {};
let balancesLoaded = false;
let isLoggedIn = false;
let openPromise: Promise<void> | undefined;
let openResolve: (() => void) | null = null;
let openReject: ((err: unknown) => void) | null = null;
let balanceRefreshTmr: NodeJS.Timeout | null = null;
const pending: Map<string, PendingEntry> = new Map();
type HtxOrderTracker = {
  canonSym: string;
  exchangeSymbol: string;
  side: 'BUY' | 'SELL';
  clientOrderId: string;
  orderId: string | number;
  transactTime: number;
  executedQty: number;
  cummulativeQuoteQty: number;
  feeAmount: number;
  feeCurrency: string;
  finalStatus: OrderState;
  orderFinalSeen: boolean;
  seenTradeClearing: boolean;
  orderExecAmt?: number;
  orderRemainAmt?: number;
  finalTimer?: NodeJS.Timeout;
};
const orderTrackers: Map<string, HtxOrderTracker> = new Map();
const orderAliases: Map<string, string> = new Map();
const BALANCE_REFRESH_MS = 15 * 60 * 1000;
const MIN_BALANCE_EPS = 1e-9;
const ORDER_FINAL_GRACE_MS = Number(process.env.HTX_ORDER_FINAL_GRACE_MS ?? process.env.HTX_FINAL_FILL_GRACE_MS ?? 250);

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

function hmacSha256Base64(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest('base64');
}

function signHtxPayload(payload: string): string {
  if (authMethod === 'Ed25519') {
    return signEd25519Base64(ed25519PrivateKeyPem, payload);
  }
  return hmacSha256Base64(apiSecret, payload);
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
    SignatureMethod: authMethod,
    SignatureVersion: opts.signatureVersion ?? '2',
    Timestamp: htxTimestamp(),
    ...(opts.extra ?? {}),
  };
  const canonicalQuery = buildCanonicalQuery(params);
  const payload = `${opts.method}\n${opts.host.toLowerCase()}\n${opts.path}\n${canonicalQuery}`;
  const signature = signHtxPayload(payload);
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
  return refreshAccountId();
}

async function refreshAccountId(): Promise<string> {
  const result = await htxPrivateRest<HtxRestResponse<HtxAccountRow[]>>({ method: 'GET', path: '/v1/account/accounts' });
  const spot = (result.data ?? []).find((row) => row.type === 'spot' && row.state !== 'locked')
    ?? (result.data ?? []).find((row) => row.type === 'spot');
  const id = String(spot?.id ?? '');
  log.debug({ accounts: result.data ?? [], selectedAccountId: id }, 'htx accounts resolved');
  if (!id) throw new Error('htx spot account id not found');
  accountId = id;
  return accountId;
}

async function fetchBalances(): Promise<Balances> {
  let id = await resolveAccountId();
  let result: HtxAccountBalanceResponse;
  try {
    result = await htxPrivateRest<HtxAccountBalanceResponse>({
      method: 'GET',
      path: `/v1/account/accounts/${id}/balance`,
    });
  } catch (err) {
    const raw = (err as Error & { context?: { rawErrorResponse?: { ['err-code']?: string } } }).context?.rawErrorResponse;
    if (raw?.['err-code'] !== 'account-get-balance-account-inexistent-error') throw err;
    log.warn({ accountId: id }, 'configured htx account id is invalid; refreshing spot account id');
    accountId = '';
    id = await refreshAccountId();
    result = await htxPrivateRest<HtxAccountBalanceResponse>({
      method: 'GET',
      path: `/v1/account/accounts/${id}/balance`,
    });
  }
  const out: Balances = {};
  for (const row of result.data?.list ?? []) {
    if (row.type !== 'trade') continue;
    const asset = String(row.currency ?? '').toUpperCase();
    if (!asset) continue;
    const balance = Number(row.balance ?? 0);
    if (!Number.isFinite(balance) || balance <= MIN_BALANCE_EPS) continue;
    out[asset] = balance;
  }
  return out;
}

function sendWsReq<T>(ch: string, data: Record<string, unknown>, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<T> {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`htx ws not open (ch=${ch})`));
  }
  const cid = String(data.clientOrderId ?? data['client-order-id'] ?? makeClientId());
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
    signatureMethod: authMethod,
    signatureVersion: '2.1',
    timestamp: htxTimestamp(),
  };
  // HTX /ws/v2 signs lowercase auth fields even though REST signs uppercase fields.
  const canonicalQuery = buildCanonicalQuery({
    accessKey: params.accessKey,
    signatureMethod: params.signatureMethod,
    signatureVersion: params.signatureVersion,
    timestamp: params.timestamp,
  });
  const payload = `GET\n${wsSignatureHost}\n${wsPath}\n${canonicalQuery}`;
  const signature = signHtxPayload(payload);
  return {
    action: 'req',
    ch: 'auth',
    params: {
      ...params,
      signature,
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

function subscribeUserData(_cfg: AppConfig): void {
  if (!wsRef || wsRef.readyState !== WebSocket.OPEN) {
    throw new Error('htx ws not open');
  }
  const symbol = '*';
  for (const ch of [`orders#${symbol}`, `trade.clearing#${symbol}#0`]) {
    wsRef.send(JSON.stringify({ action: 'sub', ch }));
  }
  log.info({ symbol }, 'htx private order and trade clearing subscribed');
}

function aliasId(value?: string | number): string {
  return value === undefined || value === null ? '' : String(value);
}

function trackerKeyFor(clientOrderId?: string | number, orderId?: string | number): string {
  const clientKey = aliasId(clientOrderId);
  const orderKey = aliasId(orderId);
  return orderAliases.get(clientKey) ?? orderAliases.get(orderKey) ?? (clientKey || orderKey);
}

function knownTrackerKey(clientOrderId?: string | number, orderId?: string | number): string {
  const clientKey = aliasId(clientOrderId);
  const orderKey = aliasId(orderId);
  return orderAliases.get(clientKey) ?? orderAliases.get(orderKey) ?? '';
}

function deleteOrderTracker(key: string, tracker: HtxOrderTracker): void {
  clearFinalTimer(tracker);
  orderTrackers.delete(key);
  if (tracker.clientOrderId) orderAliases.delete(tracker.clientOrderId);
  if (tracker.orderId !== '') orderAliases.delete(String(tracker.orderId));
}

function statusFromHtx(status?: string): OrderState {
  if (status === 'filled') return OrderStates.FILLED;
  if (status === 'partial-filled') return OrderStates.PARTIALLY_FILLED;
  if (status === 'canceled' || status === 'cancelling' || status === 'partial-canceled') return OrderStates.CANCELLED;
  return OrderStates.UNKNOWN;
}

function clearFinalTimer(tracker?: HtxOrderTracker): void {
  if (!tracker?.finalTimer) return;
  clearTimeout(tracker.finalTimer);
  tracker.finalTimer = undefined;
}

function emitFinalOrderResult(key: string, tracker: HtxOrderTracker): void {
  clearFinalTimer(tracker);
  if (tracker.finalStatus === OrderStates.FILLED && !tracker.seenTradeClearing) {
    log.warn({ key, tracker }, 'htx final order emitted without trade clearing fills');
  }

  let feeUsd = 0;
  if (tracker.feeAmount > 0 && tracker.feeCurrency) {
    const feeAssetPrice = getAssetPrice(ExchangeIds.htx, tracker.feeCurrency);
    if (feeAssetPrice == null) {
      log.warn({ currency: tracker.feeCurrency }, 'missing cached asset price');
    } else {
      feeUsd = feeAssetPrice * tracker.feeAmount;
    }
  }

  updateBalancesFromOrderData({
    side: tracker.side,
    baseAsset: getEx(tracker.canonSym, ExchangeIds.htx)!.base,
    quoteAsset: getEx(tracker.canonSym, ExchangeIds.htx)!.quote,
    executedQty: tracker.executedQty,
    cummulativeQuoteQty: tracker.cummulativeQuoteQty,
  });

  const result = {
    exchange: ExchangeIds.htx,
    symbol: tracker.exchangeSymbol,
    status: tracker.finalStatus,
    side: tracker.side,
    orderId: tracker.orderId,
    clientOrderId: tracker.clientOrderId,
    transactTime: tracker.transactTime,
    executedQty: tracker.executedQty,
    cummulativeQuoteQty: tracker.cummulativeQuoteQty,
    priceVwap: tracker.executedQty > 0 ? tracker.cummulativeQuoteQty / tracker.executedQty : 0,
    fee_amount: tracker.feeAmount,
    fee_currency: tracker.feeCurrency,
    fee_usd: feeUsd,
  };
  log.debug({ key, tracker, result }, 'htx order result emitted');
  busRef.emit('trade:order_result', result);
  deleteOrderTracker(key, tracker);
}

function scheduleFinalOrderResult(key: string, tracker: HtxOrderTracker): void {
  clearFinalTimer(tracker);
  tracker.finalTimer = setTimeout(() => {
    const latest = orderTrackers.get(key);
    if (!latest || !latest.orderFinalSeen) return;
    emitFinalOrderResult(key, latest);
  }, ORDER_FINAL_GRACE_MS);
  tracker.finalTimer.unref?.();
  // log.debug({ key, orderFinalGraceMs: ORDER_FINAL_GRACE_MS, tracker }, 'htx final order result scheduled');
}

function handleTradeDetails(msgObj: HtxWsResponse<HtxTradeClearingRow>): void {
  const row = msgObj.data;
  if (!row?.symbol) return;
  // log.debug({ row }, 'htx trade clearing raw event');
  const canonSym = getCanonFromOderSym(row.symbol.toUpperCase(), ExchangeIds.htx);
  if (!canonSym) {
    log.warn({ row }, 'htx trade clearing symbol mapping missing');
    return;
  }

  const side = row.orderSide === 'buy' ? OrderSides.BUY : OrderSides.SELL;
  const key = knownTrackerKey(row.clientOrderId, row.orderId);
  if (!key) {
    log.debug({ clientOrderId: row.clientOrderId, orderId: row.orderId }, 'ignore htx trade clearing for unknown order');
    return;
  }
  const tracker = orderTrackers.get(key);
  if (!tracker) return;
  tracker.clientOrderId = tracker.clientOrderId || aliasId(row.clientOrderId);
  tracker.orderId = tracker.orderId || aliasId(row.orderId);
  if (tracker.clientOrderId) orderAliases.set(tracker.clientOrderId, key);
  if (tracker.orderId !== '') orderAliases.set(String(tracker.orderId), key);

  if (row.eventType === 'cancellation') {
    tracker.finalStatus = OrderStates.CANCELLED;
    tracker.orderFinalSeen = true;
    scheduleFinalOrderResult(key, tracker);
    return;
  }
  if (row.eventType !== 'trade') return;

  const tradeQty = Number(row.tradeVolume ?? 0);
  const tradePrice = Number(row.tradePrice ?? 0);
  const quoteQty = tradeQty * tradePrice;
  const feeDeductAmount = Number(row.feeDeduct ?? NaN);
  const transactFeeAmount = Number(row.transactFee ?? 0);
  const feeAmount = Number.isFinite(feeDeductAmount) && feeDeductAmount > 0 ? feeDeductAmount : transactFeeAmount;
  const feeCurrency = String(
    Number.isFinite(feeDeductAmount) && feeDeductAmount > 0 ? row.feeDeductType : row.feeCurrency ?? ''
  ).toUpperCase();
  tracker.seenTradeClearing = true;
  tracker.executedQty += Number.isFinite(tradeQty) ? tradeQty : 0;
  tracker.cummulativeQuoteQty += Number.isFinite(quoteQty) ? quoteQty : 0;
  tracker.feeAmount += Number.isFinite(feeAmount) ? feeAmount : 0;
  tracker.feeCurrency = feeCurrency || tracker.feeCurrency;
  tracker.transactTime = Number(row.tradeTime ?? tracker.transactTime);
  log.debug({
    key,
    orderStatus: row.orderStatus,
    tradeQty,
    tradePrice,
    quoteQty,
    feeAmount,
    feeCurrency,
    execAmt: row.execAmt,
    remainAmt: row.remainAmt,
    orderSize: row.orderSize,
    orderValue: row.orderValue,
    tracker,
  }, 'htx trade clearing accumulated order');

  if (tracker.orderFinalSeen) scheduleFinalOrderResult(key, tracker);
}

function handleOrderUpdate(msgObj: HtxWsResponse<HtxOrderUpdateRow>): void {
  const row = msgObj.data;
  if (!row?.symbol) return;
  log.debug({ row }, 'htx order update raw event');
  const canonSym = getCanonFromOderSym(row.symbol.toUpperCase(), ExchangeIds.htx);
  if (!canonSym) {
    log.warn({ row }, 'htx order update symbol mapping missing');
    return;
  }

  const side = row.orderSide === 'buy' ? OrderSides.BUY : OrderSides.SELL;
  const key = knownTrackerKey(row.clientOrderId, row.orderId);
  if (!key) {
    log.debug({ clientOrderId: row.clientOrderId, orderId: row.orderId }, 'ignore htx order update for unknown order');
    return;
  }
  const tracker = orderTrackers.get(key);
  if (!tracker) return;
  tracker.clientOrderId = tracker.clientOrderId || aliasId(row.clientOrderId);
  tracker.orderId = tracker.orderId || aliasId(row.orderId);
  if (tracker.clientOrderId) orderAliases.set(tracker.clientOrderId, key);
  if (tracker.orderId !== '') orderAliases.set(String(tracker.orderId), key);

  const execAmt = Number(row.execAmt ?? NaN);
  const remainAmt = Number(row.remainAmt ?? NaN);
  if (Number.isFinite(execAmt)) tracker.orderExecAmt = execAmt;
  if (Number.isFinite(remainAmt)) tracker.orderRemainAmt = remainAmt;
  tracker.transactTime = Number(row.tradeTime ?? row.lastActTime ?? tracker.transactTime);

  const status = statusFromHtx(row.orderStatus);
  tracker.finalStatus = status;
  tracker.orderFinalSeen = status === OrderStates.FILLED || status === OrderStates.CANCELLED;

  log.debug({
    key,
    status,
    execAmt: row.execAmt,
    remainAmt: row.remainAmt,
    orderSize: row.orderSize,
    orderValue: row.orderValue,
    tracker,
  }, 'htx order update parsed');

  if (!tracker.orderFinalSeen) return;
  scheduleFinalOrderResult(key, tracker);
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
  if (parsed.action === 'push' && parsed.ch?.startsWith('orders#')) {
    handleOrderUpdate(parsed as HtxWsResponse<HtxOrderUpdateRow>);
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
  if (authMethod === 'Ed25519') {
    if (!apiKey || !ed25519PrivateKeyFile) {
      throw new Error('Missing HTX Ed25519 credentials: HTX_ED25519_ACCESS_KEY and HTX_ED25519_PRIVATE_KEY_FILE are required');
    }
    ed25519PrivateKeyPem = fs.readFileSync(ed25519PrivateKeyFile, 'utf8');
  } else if (!apiKey || !apiSecret) {
    throw new Error('Missing HTX HMAC credentials: HTX_API_KEY and HTX_API_SECRET are required');
  }
  // log.debug({ authMethod, accessKeySuffix: apiKey.slice(-8) }, 'htx credentials loaded');

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
  const data: Record<string, unknown> = {
    'account-id': accountId || await resolveAccountId(),
    source: 'spot-api',
    type: htxOrderType(orderParams.side, orderParams.type),
    symbol: orderParams.symbol.toLowerCase(),
    'client-order-id': orderParams.orderId,
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
  log.debug({data}, 'ORDER!!!!');
  try {
    const response = await htxPrivateRest<HtxRestResponse<string>>({
      method: 'POST',
      path: '/v1/order/orders/place',
      body: data,
    });
    log.debug({ data, rawOrderResponse: response }, 'htx placeOrder rest response');
    if (response.data !== undefined) {
      const canonSym = getCanonFromOderSym(orderParams.symbol.toUpperCase(), ExchangeIds.htx);
      if (!canonSym) {
        log.warn({ orderParams, orderId: response.data }, 'htx placed order symbol mapping missing');
        return;
      }
      const clientOrderId = aliasId(orderParams.orderId);
      const orderId = response.data;
      const key = trackerKeyFor(clientOrderId, orderId);
      const tracker: HtxOrderTracker = {
        canonSym,
        exchangeSymbol: orderParams.symbol.toUpperCase(),
        side: orderParams.side,
        clientOrderId,
        orderId,
        transactTime: Date.now(),
        executedQty: 0,
        cummulativeQuoteQty: 0,
        feeAmount: 0,
        feeCurrency: '',
        finalStatus: OrderStates.UNKNOWN,
        orderFinalSeen: false,
        seenTradeClearing: false,
      };
      orderTrackers.set(key, tracker);
      if (clientOrderId) orderAliases.set(clientOrderId, key);
      orderAliases.set(String(orderId), key);
      log.debug({ clientOrderId, orderId, symbol: orderParams.symbol }, 'htx placed order registered');
    }
  } catch (err) {
    log.error({ err, data }, 'htx placeOrder failed');
    throw err;
  }
}

async function cancelOrder(params: CancelOrderParams): Promise<void> {
  if (!isLoggedIn) {
    throw new Error('htx ws-api not logged in');
  }
  if (params.orderId === undefined) {
    throw new Error('htx cancelOrder requires orderId');
  }
  const path = `/v1/order/orders/${params.orderId}/submitcancel`;
  try {
    const response = await htxPrivateRest<HtxRestResponse<string>>({
      method: 'POST',
      path,
    });
    log.debug({ orderId: params.orderId, rawCancelResponse: response }, 'htx cancelOrder rest response');
  } catch (err) {
    log.error({ err, orderId: params.orderId }, 'htx cancelOrder failed');
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
