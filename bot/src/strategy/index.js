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

const bus = require('../bus');
const { computeIntents } = require('./engine');

const { getLogger } = require('../logger');
const log = getLogger('strategy');

function key(ex, sym) {
  return `${ex}|${sym}`;
}

module.exports = function startStrategy(cfg) {
  const cooldownS = Number(cfg.bot.cooldown_s);
  const throttleMs = Number(cfg.bot.throttle_ms ?? 200);

  const symbolsSet = new Set(cfg.symbols);

  const latest = new Map();       // key(ex,sym) -> l2 snapshot
  const lastIntentAt = new Map(); // `${sym}|buy->sell` -> tsMs
  const lastRunAt = new Map();    // sym -> tsMs (throttle)

  function tryComputeForSymbol(sym) {
    if (!symbolsSet.has(sym)) return;

    const nowMs = Date.now();
    const lastRun = lastRunAt.get(sym);
    if (lastRun != null) {
      const delta = nowMs - lastRun;
      if (delta < throttleMs) {
        return;
      }
    }
    lastRunAt.set(sym, nowMs);

    // Compute intents only for this symbol
    const intents = computeIntents({
      latest,
      fees:cfg.exchanges,
      nowMs,
      cfg
    });

    for (const it of intents) {
      const route = `${it.buyEx}->${it.sellEx}`;
      const ck = `${it.symbol}|${route}`;

      const last = lastIntentAt.get(ck);
      if (last != null && (nowMs - last) < cooldownS * 1000) continue;

      lastIntentAt.set(ck, nowMs);

      bus.emit('trade:intent', {
        id: crypto.randomUUID(),
        tsMs: nowMs,
        ...it,
      });
    }
  }

  bus.on('md:l2', (m) => {
    latest.set(key(m.exchange, m.symbol), m);
    log.debug({ latest: Object.fromEntries(latest) }, 'latest dump');
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
      symbols: cfg.symbols.length,
    },
    'started',
  );
};

