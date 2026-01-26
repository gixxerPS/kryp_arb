const { feePctToFactor } = require('../util');

function rawSpread(buyAsk, sellBid) {
  return (sellBid - buyAsk) / buyAsk;
}

// latest: Map("ex|sym" -> l2 object)
// returns: array of intents
function computeIntents({ latest, symbols, exchanges, fees, nowMs, cfg }) {
  const minRaw = Number(cfg.min_raw_spread_pct) / 100.0;
  const slippage = Number(cfg.slippage_pct) / 100.0;
  const qMin = Number(cfg.q_min_usdt);
  const qMax = Number(cfg.q_max_usdt);

  const intents = [];

  function key(ex, sym) {
    return `${ex}|${sym}`;
  }

  for (const sym of symbols) {
    for (const buyEx of exchanges) {
      for (const sellEx of exchanges) {
        if (buyEx === sellEx) continue;

        const buy = latest.get(key(buyEx, sym));
        const sell = latest.get(key(sellEx, sym));
        if (!buy || !sell) continue;

        if (nowMs - buy.tsMs > 1500) continue;
        if (nowMs - sell.tsMs > 1500) continue;

        const buyAsk = Number(buy.bestAsk);
        const sellBid = Number(sell.bestBid);
        if (!Number.isFinite(buyAsk) || !Number.isFinite(sellBid)) continue;

        const raw = rawSpread(buyAsk, sellBid);
        if (raw < minRaw) continue;

        const buyFee = feePctToFactor(fees[buyEx].taker_fee_pct);
        const sellFee = feePctToFactor(fees[sellEx].taker_fee_pct);
        const net = raw - buyFee - sellFee - slippage;
        if (net <= 0) continue;

        const qMaxBuy = Number(buy.askQtyL10) * buyAsk;
        const qMaxSell = Number(sell.bidQtyL10) * sellBid;
        if (!Number.isFinite(qMaxBuy) || !Number.isFinite(qMaxSell)) continue;

        const qEff = Math.min(qMax, qMaxBuy, qMaxSell);
        if (qEff < qMin) continue;

        intents.push({
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

  return intents;
}

module.exports = { computeIntents };

