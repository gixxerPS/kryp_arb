const crypto = require('crypto');

const bus = require('../bus');
const { getLogger } = require('../logger');
const { feePctToFactor } = require('../util');

const log = getLogger('strategy');

function rawSpread(buyAsk, sellBid) {
  return (sellBid - buyAsk) / buyAsk;
}

function key(ex, sym) {
  return `${ex}|${sym}`;
}

module.exports = function startStrategy(cfg, fees) {
  const tickMs = Number(cfg.tick_ms);
  const cooldownS = Number(cfg.cooldown_s);
  const minRaw = Number(cfg.min_raw_spread_pct) / 100.0;
  const slippage = Number(cfg.slippage_pct) / 100.0;
  const qMin = Number(cfg.q_min_usdt);
  const qMax = Number(cfg.q_max_usdt);

  const exchanges = cfg.exchanges;
  const symbols = cfg.symbols;

  const latest = new Map(); // key(ex,sym) -> l2
  bus.on('md:l2', (m) => {
    latest.set(key(m.exchange, m.symbol), m);
  });

  const lastIntentAt = new Map(); // `${sym}|buy->sell` -> tsMs

  log.info(
    { tickMs, cooldownS, minRawPct: cfg.min_raw_spread_pct, slippagePct: cfg.slippage_pct, qMin, qMax },
    'started',
  );

  setInterval(() => {
    const now = Date.now();

    for (const sym of symbols) {
      for (const buyEx of exchanges) {
        for (const sellEx of exchanges) {
          if (buyEx === sellEx) continue;

          const buy = latest.get(key(buyEx, sym));
          const sell = latest.get(key(sellEx, sym));
          if (!buy || !sell) continue;

          // stale guard
          if (now - buy.tsMs > 1500) continue;
          if (now - sell.tsMs > 1500) continue;

          const buyAsk = Number(buy.bestAsk);
          const sellBid = Number(sell.bestBid);
          if (!Number.isFinite(buyAsk) || !Number.isFinite(sellBid)) continue;

          const raw = rawSpread(buyAsk, sellBid);
          if (raw < minRaw) continue;

          const buyFee = feePctToFactor(fees[buyEx].taker_fee_pct);
          const sellFee = feePctToFactor(fees[sellEx].taker_fee_pct);
          const net = raw - buyFee - sellFee - slippage;
          if (net <= 0) continue;

          // Variante A: dynamische Größe aus L2
          const qMaxBuy = Number(buy.askQtyL10) * buyAsk;
          const qMaxSell = Number(sell.bidQtyL10) * sellBid;
          if (!Number.isFinite(qMaxBuy) || !Number.isFinite(qMaxSell)) continue;

          const qEff = Math.min(qMax, qMaxBuy, qMaxSell);
          if (qEff < qMin) continue;

          const route = `${buyEx}->${sellEx}`;
          const ck = `${sym}|${route}`;
          const last = lastIntentAt.get(ck);
          if (last != null && (now - last) < cooldownS * 1000) continue;

          lastIntentAt.set(ck, now);

          bus.emit('trade:intent', {
            id: crypto.randomUUID(),
            tsMs: now,
            symbol: sym,
            buyEx,
            sellEx,
            qUsdt: qEff,
            edgeNet: net,
            buyAsk,
            sellBid,
          });
        }
      }
    }
  }, tickMs);
};

