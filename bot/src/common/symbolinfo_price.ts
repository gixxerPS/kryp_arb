import { getLogger } from './logger';
import { getTrackedOrderSymbols, getCommissionAssetSym } from './symbolinfo';

import { ExchangeIds, type ExchangeId } from '../types/common';

const log = getLogger('symbolinfo_price');

const PRICE_REFRESH_MS = 15 * 60 * 1000; // every 15 min

type PriceEntry = {
  price: number;
  tsMs: number;
};

type PriceCache = Partial<Record<ExchangeId, Record<string, PriceEntry>>>;

type PriceFetcher = (symbols: string[]) => Promise<Record<string, number>>;

let cache: PriceCache = {};
let initPromise: Promise<void> | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshTmr: NodeJS.Timeout | null = null;

function deriveAssetFromSymbol(symbol: string): string | null {
  if (!symbol) return null;
  if (symbol.includes('_')) {
    const [base] = symbol.split('_');
    return base || null;
  }

  const knownQuotes = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USD'];
  for (const quote of knownQuotes) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) {
      return symbol.slice(0, -quote.length) || null;
    }
  }

  return null;
}

function deriveQuoteFromSymbol(symbol: string): string | null {
  if (!symbol) return null;
  if (symbol.includes('_')) {
    const [, quote] = symbol.split('_');
    return quote || null;
  }

  const knownQuotes = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USD'];
  for (const quote of knownQuotes) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) {
      return quote;
    }
  }

  return null;
}

function isUsdLikeAsset(asset: string): boolean {
  return ['USD', 'USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD'].includes(asset);
}

function getTrackedPriceSymbols(exchange: ExchangeId): string[] {
  const out = new Set<string>(getTrackedOrderSymbols(exchange));
  const commissionAssetSym = getCommissionAssetSym(exchange);
  if (commissionAssetSym) out.add(commissionAssetSym);
  return Array.from(out);
}

function getSupportedExchanges(): ExchangeId[] {
  return [ExchangeIds.binance, ExchangeIds.gate, 
    ExchangeIds.bitget, ExchangeIds.mexc];
}

async function fetchBinancePrices(symbols: string[]): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  const query = encodeURIComponent(JSON.stringify(symbols));
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${query}`);
  if (!res.ok) throw new Error(`binance ticker failed status=${res.status}`);

  const rows = (await res.json()) as Array<{ symbol?: string; price?: string }>;
  const out: Record<string, number> = {};
  for (const row of rows) {
    const symbol = row?.symbol;
    const price = Number(row?.price ?? NaN);
    if (!symbol || !Number.isFinite(price) || price <= 0) continue;
    out[symbol] = price;
  }
  return out;
}

async function fetchGatePrice(symbol: string): Promise<number> {
  const host = process.env.GATE_REST_HOST ?? 'https://api.gateio.ws';
  const url = `${host}/api/v4/spot/tickers?currency_pair=${symbol}`;
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`gate ticker failed status=${res.status} pair=${symbol}`);

  const rows = (await res.json()) as Array<{ currency_pair?: string; last?: string }>;
  const price = Number(rows?.[0]?.last ?? NaN);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`invalid gate price pair=${symbol}`);
  }
  return price;
}

async function fetchGatePrices(symbols: string[]): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  const results = await Promise.allSettled(
    symbols.map(async (symbol) => [symbol, await fetchGatePrice(symbol)] as const)
  );

  const out: Record<string, number> = {};
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const [symbol, price] = result.value;
    out[symbol] = price;
  }
  return out;
}

async function fetchBitgetPrice(symbol: string): Promise<number> {
  const host = process.env.BITGET_REST_HOST ?? 'https://api.bitget.com';
  const url = `${host}/api/v2/spot/market/tickers?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`bitget ticker failed status=${res.status} symbol=${symbol}`);

  const body = (await res.json()) as {
    code?: string;
    msg?: string;
    data?: Array<{ symbol?: string; lastPr?: string }>;
  };
  if (body?.code !== '00000') {
    throw new Error(`bitget ticker failed code=${body?.code ?? 'unknown'} symbol=${symbol} msg=${body?.msg ?? ''}`);
  }

  const price = Number(body?.data?.[0]?.lastPr ?? NaN);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`invalid bitget price symbol=${symbol}`);
  }
  return price;
}

async function fetchBitgetPrices(symbols: string[]): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  const results = await Promise.allSettled(
    symbols.map(async (symbol) => [symbol, await fetchBitgetPrice(symbol)] as const)
  );

  const out: Record<string, number> = {};
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const [symbol, price] = result.value;
    out[symbol] = price;
  }
  return out;
}

async function fetchMexcPrice(symbol: string): Promise<number> {
  const host = process.env.MEXC_REST_HOST ?? 'https://api.mexc.com';
  const url = `${host}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`mexc ticker failed status=${res.status} symbol=${symbol}`);

  const body = (await res.json()) as { symbol?: string; price?: string };
  const price = Number(body?.price ?? NaN);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`invalid mexc price symbol=${symbol}`);
  }
  return price;
}

async function fetchMexcPrices(symbols: string[]): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  const results = await Promise.allSettled(
    symbols.map(async (symbol) => [symbol, await fetchMexcPrice(symbol)] as const)
  );

  const out: Record<string, number> = {};
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const [symbol, price] = result.value;
    out[symbol] = price;
  }
  return out;
}

function getFetcher(exchange: ExchangeId): PriceFetcher | null {
  if (exchange === ExchangeIds.binance) return fetchBinancePrices;
  if (exchange === ExchangeIds.gate) return fetchGatePrices;
  if (exchange === ExchangeIds.bitget) return fetchBitgetPrices;
  if (exchange === ExchangeIds.mexc) return fetchMexcPrices;
  return null;
}

async function refreshExchange(exchange: ExchangeId): Promise<void> {
  const symbols = getTrackedPriceSymbols(exchange);
  if (symbols.length === 0) {
    cache[exchange] = {};
    return;
  }

  const fetcher = getFetcher(exchange);
  if (!fetcher) {
    log.warn({ exchange }, 'no symbol price fetcher registered');
    return;
  }

  const prices = await fetcher(symbols);
  log.debug({ exchange, symbolCount: symbols.length }, 'refreshed symbol prices');
  const tsMs = Date.now();
  const next: Record<string, PriceEntry> = {};
  for (const [symbol, price] of Object.entries(prices)) {
    next[symbol] = { price, tsMs };
  }
  cache[exchange] = next;
}

async function refreshAll(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const results = await Promise.allSettled(
      getSupportedExchanges().map(async (exchange) => {
        await refreshExchange(exchange);
      })
    );

    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        log.warn({ err: result.reason, exchange: getSupportedExchanges()[idx] }, 'symbol price refresh failed');
      }
    });
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function startRefreshLoop(): void {
  if (process.env.NODE_ENV === 'development') return;
  if (refreshTmr) return;

  refreshTmr = setInterval(() => {
    refreshAll().catch((err: unknown) => {
      log.warn({ err }, 'symbol price refresh loop failed');
    });
  }, PRICE_REFRESH_MS);
  refreshTmr.unref?.();
}

export async function initSymbolInfoPrice(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await refreshAll();
    startRefreshLoop();
  })();

  return initPromise;
}

export function getLastPrice(exchange: ExchangeId, symbol: string): number | null {
  const entry = cache[exchange]?.[symbol];
  return entry ? entry.price : null;
}

export function getAssetPrice(exchange: ExchangeId, asset: string): number | null {
  if (isUsdLikeAsset(asset)) return 1;

  const commissionAssetSym = getCommissionAssetSym(exchange);
  if (commissionAssetSym) {
    const commissionAsset = deriveAssetFromSymbol(commissionAssetSym);
    if (commissionAsset === asset) {
      return getLastPrice(exchange, commissionAssetSym);
    }
  }

  const exchangeCache = cache[exchange] ?? {};
  for (const [symbol, entry] of Object.entries(exchangeCache)) {
    const baseAsset = deriveAssetFromSymbol(symbol);
    const quoteAsset = deriveQuoteFromSymbol(symbol);
    if (baseAsset !== asset || !quoteAsset || !isUsdLikeAsset(quoteAsset)) continue;
    return entry.price;
  }

  return null;
}
