import bus from '../bus';
import { getExState } from '../common/exchange_state';
import { getLogger } from '../common/logger';
import { makeClientId, tradeRouteKey } from '../common/util';
import { computeIntentsForSym as appCompute, initStrategyEngine } from './engine';

import type { AppConfig } from '../types/config';
import type { ComputeIntentsForSym, L2Snapshot, StrategyDeps, TradeIntent, TradeIntentDraft } from '../types/strategy';

const log = getLogger('strategy');

function key(ex: L2Snapshot['exchange'], sym: string): string {
  return `${ex}|${sym}`;
}

function formatLevelsInline(levels: L2Snapshot['bids']): string {
  return levels.map(([price, qty]) => `[${price}, ${qty}]`).join(' ');
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

function makeTradeIntent(draft: TradeIntentDraft, nowMs: number, ttlMs: number, uuidFn: () => string): TradeIntent {
  return {
    id: uuidFn(),
    tsMs: nowMs,
    valid_until: new Date(nowMs + ttlMs),
    ...draft,
  };
}

export default function startStrategy(cfg: AppConfig, deps: StrategyDeps = {}): void {
  initStrategyEngine(cfg);

  const appBus = deps.bus ?? bus;
  const getExStateFct = deps.getExState ?? getExState;
  const computeIntentsForSymbol = deps.computeIntentsForSymbol ?? (appCompute as ComputeIntentsForSym);
  const nowFn = deps.nowFn ?? (() => Date.now());
  const uuidFn = deps.uuidFn ?? makeClientId;
  const exState = getExStateFct();
  if (!exState) throw new Error('exchange_state not initialized');
  const readyExState = exState;

  const cooldownMs = Number(cfg.bot.cooldown_ms ?? (Number(cfg.bot.cooldown_s ?? 0) * 1000));
  const throttleMs = Number(cfg.bot.throttle_ms ?? 200);
  const ttlMs = Number(cfg.bot.intent_time_to_live_ms ?? 1500);
  const symbolsSet = new Set(cfg.symbols);

  const latest = new Map<string, L2Snapshot>();
  const lastIntentAt = new Map<string, number>();
  const lastRunAt = new Map<string, number>();

  function tryComputeForSymbol(sym: string): void {
    if (!symbolsSet.has(sym)) return;

    const nowMs = nowFn();
    const lastRun = lastRunAt.get(sym);
    if (lastRun != null && nowMs - lastRun < throttleMs) return;
    lastRunAt.set(sym, nowMs);

    const intents = computeIntentsForSymbol({
      sym,
      latest,
      fees: cfg.exchanges,
      nowMs,
      cfg,
      exState: readyExState,
    });

    for (const draft of intents) {
      const routeKey = tradeRouteKey(draft);
      const last = lastIntentAt.get(routeKey);
      if (last != null && nowMs - last < cooldownMs) {
        log.debug({ reason: 'cooldown violation', routeKey, age: nowMs - last, cooldownMs }, 'dropped trade');
        continue;
      }
      lastIntentAt.set(routeKey, nowMs);

      const intent = makeTradeIntent(draft, nowMs, ttlMs, uuidFn);
      log.debug({ intent }, 'trade:intent found');
      appBus.emit('trade:intent', intent);
    }
  }

  // debug
  // setInterval(() => {
  //   log.debug({
  //     latest: Object.fromEntries(
  //       Array.from(latest.entries(), ([snapshotKey, snapshot]) => [snapshotKey, formatSnapshotForDebug(snapshot)])
  //     ),
  //   }, 'latest');
  // }, 10000);

  appBus.on('md:l2', (m: L2Snapshot) => {
    latest.set(key(m.exchange, m.symbol), m);
    tryComputeForSymbol(m.symbol);
  });

  log.debug({
    mode: 'event-driven',
    cooldownMs,
    throttleMs,
    rawSpreadBufferPct: cfg.bot.raw_spread_buffer_pct,
    slippagePct: cfg.bot.slippage_pct,
    qMinUsdt: cfg.bot.q_min_usdt,
    qMaxUsdt: cfg.bot.q_max_usdt,
  }, 'started');
}
