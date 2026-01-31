// bot/src/strategy/index.js
//
// Strategy runner:
// - Maintains latest L2 snapshots per (exchange,symbol) from EventEmitter bus.
// Event-driven Strategy:
// - Updates latest L2 per (exchange,symbol).
// - On md:l2 update, computes intents for that symbol
//   at most once every throttle_ms.
// - Computes intents for that symbol only, applies cooldown, emits trade:intent.
// - Applies cooldown + assigns intent id + emits trade:intent.
//
// Config (from bot/config/bot.json):
// - tick_ms
// - cooldown_s
// - min_raw_spread_pct
// - slippage_pct
// - q_min_usdt
// - q_max_usdt
// - exchanges[]
// - symbols[]
//
const crypto = require('crypto');

const appBus = require('../bus');
const { computeIntentsForSym: appCompute } = require('./engine');
const { tradeRouteKey } = require('../util');

const { getLogger } = require('../logger');
const log = getLogger('strategy');

function key(ex, sym) {
  return `${ex}|${sym}`;
}

module.exports = function startStrategy(cfg, deps = {}) { // deps machen es testbar durch injektion
  const bus = deps.bus ?? appBus;
  const computeIntentsForSym = deps.computeIntentsForSymbol ?? appCompute;
  const nowFn = deps.nowFn ?? (() => Date.now());
  const uuidFn = deps.uuidFn ?? (() => crypto.randomUUID());

  const cooldownS = Number(cfg.bot.cooldown_s);
  const throttleMs = Number(cfg.bot.throttle_ms ?? 200);
  const ttlMs = Number(cfg.bot.intent_time_to_live_ms ?? 1500);

  const symbolsSet = new Set(cfg.bot.symbols);

  const latest = new Map();       // key(ex,sym) -> l2 snapshot
  const lastIntentAt = new Map(); // `${sym}|buy->sell` -> tsMs
  const lastRunAt = new Map();    // sym -> tsMs (throttle)

  function tryComputeForSymbol(sym) {
    if (!symbolsSet.has(sym)) return;

    const nowMs = nowFn();
    const lastRun = lastRunAt.get(sym);
    if (lastRun != null) {
      const delta = nowMs - lastRun;
      if (delta < throttleMs) {
        return;
      }
    }
    lastRunAt.set(sym, nowMs);

    // Compute intents only for this symbol
    const intents = computeIntentsForSym({
      sym,
      latest,
      fees:cfg.exchanges,
      nowMs,
      cfg
    });

    for (const it of intents) {
      const rk = tradeRouteKey(it);

      const last = lastIntentAt.get(rk);
      if (last != null && (nowMs - last) < cooldownS * 1000) {
        log.debug({rk, age:nowMs - last, cooldownS}, 'trade chance ignored due to coolDown');
        continue;
      }
      lastIntentAt.set(rk, nowMs);

      bus.emit('trade:intent', {
        id: uuidFn(),
        tsMs: nowMs,
        valid_until: new Date(nowMs + ttlMs),
        ...it,
      });
    }
  }

  bus.on('md:l2', (m) => {
    latest.set(key(m.exchange, m.symbol), m);
    //log.debug({ latest: Object.fromEntries(latest) }, 'latest dump');
    //log.debug({latest:latest, m:m, key:key(m.exchange, m.symbol)}, 'md:l2');
    tryComputeForSymbol(m.symbol);
  });

  log.info({
      mode: 'event-driven',
      cooldownS,
      throttleMs,
      minRawSpreadPct: cfg.bot.min_raw_spread_pct,
      slippagePct: cfg.bot.slippage_pct,
      qMinUsdt: cfg.bot.q_min_usdt,
      qMaxUsdt: cfg.bot.q_max_usdt,
    },
    'started',
  );
};

