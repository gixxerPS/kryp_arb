import appBus from '../bus';
import { 
  computeIntentsForSymV2 as appComputeV2,
  initStrategyEngine } from './engine';
import { tradeRouteKey, makeClientId, formatLevelsInline } from '../common/util';
import { getLogger } from '../common/logger';
import { getExState as appGetExState } from '../common/exchange_state';

import type { AppConfig } from '../types/config';
import type {
  ComputeIntentsForSym,
  L2Snapshot,
  StrategyDeps,
  StrategyHandle,
  StrategyLatestMapEntry,
  StrategyLatestMapView,
  TradeIntent,
  TradeIntentDraft,
} from '../types/strategy';

const log = getLogger('strategy');

function key(ex: L2Snapshot['exchange'], sym: string): string {
  return `${ex}|${sym}`;
}

function makeTradeIntent(
  draft: TradeIntentDraft,
  nowMs: number,
  ttlMs: number,
  uuidFn: () => string
): TradeIntent {
  return {
    id: uuidFn(),
    tsMs: nowMs,
    valid_until: new Date(nowMs + ttlMs),
    ...draft,
  };
}

function formatSnapshotForDebug(snapshot: L2Snapshot): Record<string, unknown> {
  return {
    tsMs: snapshot.tsMs,
    exchange: snapshot.exchange,
    symbol: snapshot.symbol,
    bids: formatLevelsInline(snapshot.bids),
    asks: formatLevelsInline(snapshot.asks),
  };
}

function buildLatestMapEntry(snapshotKey: string, snapshot: L2Snapshot): StrategyLatestMapEntry {
  return {
    snapshotKey,
    exchange: snapshot.exchange,
    symbol: snapshot.symbol,
    tsMs: snapshot.tsMs,
    bids: formatLevelsInline(snapshot.bids),
    asks: formatLevelsInline(snapshot.asks),
  };
}

function buildIntentL2Debug(intent: TradeIntent, latest: Map<string, L2Snapshot>, nowMs: number): Record<string, unknown> {
  const buy = latest.get(key(intent.buyEx, intent.symbol));
  const sell = latest.get(key(intent.sellEx, intent.symbol));
  return {
    buy: buy ? {
      exchange: buy.exchange,
      tsAgeMs: nowMs - buy.tsMs,
      asks: formatLevelsInline(buy.asks),
    } : null,
    sell: sell ? {
      exchange: sell.exchange,
      tsAgeMs: nowMs - sell.tsMs,
      bids: formatLevelsInline(sell.bids),
    } : null,
  };
}

export default function startStrategy(cfg: AppConfig, deps: StrategyDeps = {}): StrategyHandle {
  initStrategyEngine(cfg); // werte vorberechnen fuer schnellen hotpath

  const bus = deps.bus ?? appBus;
  const getExStateFct = deps.getExState ?? appGetExState;
  const computeIntentsForSymV2 = deps.computeIntentsForSymbolV2 ?? (appComputeV2 as ComputeIntentsForSym);
  const nowFn = deps.nowFn ?? (() => Date.now());
  const uuidFn = deps.uuidFn ?? makeClientId;
  const exState = getExStateFct();

  if (!exState) {
    throw new Error('exchange_state not initialized');
  }
  const exchangeState = exState;

  const cooldownMs = Number(cfg.bot.cooldown_ms);
  const throttleMs = Number(cfg.bot.throttle_ms);
  const ttlMs = Number(cfg.bot.intent_time_to_live_ms);

  const symbolsSet = new Set(cfg.symbols);
  const latest = new Map<string, L2Snapshot>();
  const lastIntentAt = new Map<string, number>();
  const lastRunAt = new Map<string, number>();

  function getLatestMap(symbol?: string): StrategyLatestMapView {
    const normalizedSymbol = symbol?.trim();
    const out: StrategyLatestMapView = {};

    for (const [snapshotKey, snapshot] of latest.entries()) {
      if (normalizedSymbol && snapshot.symbol !== normalizedSymbol) {
        continue;
      }
      out[snapshotKey] = buildLatestMapEntry(snapshotKey, snapshot);
    }
    log.debug(
      normalizedSymbol ? { symbol: normalizedSymbol, latest: out } : { latest: out },
      normalizedSymbol ? 'latest strategy map for symbol' : 'latest strategy map'
    );
    return out;
  }

  function tryComputeForSymbol(sym: string): void {
    if (!symbolsSet.has(sym)) return;

    const nowMs = nowFn();
    const lastRun = lastRunAt.get(sym);
    if (lastRun != null && nowMs - lastRun < throttleMs) {
      return;
    }
    lastRunAt.set(sym, nowMs);

    // const intents = computeIntentsForSym({
    const intents = computeIntentsForSymV2({
      sym,
      latest,
      fees: cfg.exchanges,
      nowMs,
      cfg,
      exState: exchangeState,
    });

    // absteigend sortieren nach pnl 
    const sortedIntents = [...intents].sort((a, b) => b.expectedPnl - a.expectedPnl);

    for (const it of sortedIntents) {
      const rk = tradeRouteKey(it);
      const last = lastIntentAt.get(rk);
      if (last != null && nowMs - last < cooldownMs) {
        continue;
      }

      lastIntentAt.set(rk, nowMs);
      const intent = makeTradeIntent(it, nowMs, ttlMs, uuidFn);
      log.debug({ intent, l2: buildIntentL2Debug(intent, latest, nowMs) }, 'trade:intent found');
      bus.emit('trade:intent', intent);

      /* nach profitabelstem intent aufhoeren. executor fuehrt eh 
       * nur 1 trade zeitgleich aus und ist ca 100 - 200 ms spaeter
       * bereit fuer den naechsten.
       */
      break; 
    }
  }

  bus.on('md:l2', (m: L2Snapshot) => {
    latest.set(key(m.exchange, m.symbol), m);
    tryComputeForSymbol(m.symbol);
  });

  // debug output
  // const t = setInterval(() => {
  //   log.debug({
  //     latest: Object.fromEntries(
  //       Array.from(latest.entries(), ([snapshotKey, snapshot]) => [snapshotKey, formatSnapshotForDebug(snapshot)])
  //     ),
  //   }, 'latest');
  // }, 10_000);
  // t.unref?.();

  log.debug({
      mode: 'event-driven',
      cooldownMs,
      throttleMs,
      rawSpreadBufferPct: cfg.bot.raw_spread_buffer_pct,
      slippagePct: cfg.bot.slippage_pct,
      qMinUsdt: cfg.bot.q_min_usdt,
      qMaxUsdt: cfg.bot.q_max_usdt,
  },'started');

  return {
    getLatestMap,
  };
}
