// bot/src/collector/parsers/binance_depth.js
const { symFromExchange } = require('../../util');

function sumQty(levels, n) {
  let s = 0;
  const lim = Math.min(levels.length, n);
  for (let i = 0; i < lim; i += 1) {
    const q = Number(levels[i][1]);
    if (Number.isFinite(q)) s += q;
  }
  return s;
}

function parseBinanceDepthMessage(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || !parsed.stream || !parsed.data) return null;

  const stream = String(parsed.stream);
  const at = stream.indexOf('@');
  const base = at !== -1 ? stream.slice(0, at) : stream;
  const symbol = symFromExchange(base);

  const bids = Array.isArray(parsed.data.bids) ? parsed.data.bids : [];
  const asks = Array.isArray(parsed.data.asks) ? parsed.data.asks : [];
  if (bids.length === 0 || asks.length === 0) return null;

  const bestBid = Number(bids[0][0]);
  const bestAsk = Number(asks[0][0]);
  const bidL1 = Number(bids[0][1]);
  const askL1 = Number(asks[0][1]);

  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
  if (!Number.isFinite(bidL1) || !Number.isFinite(askL1)) return null;

  const bidL10 = sumQty(bids, 10);
  const askL10 = sumQty(asks, 10);

  return {
    symbol,
    bestBid,
    bestAsk,
    bidQtyL1: bidL1,
    askQtyL1: askL1,
    bidQtyL10: bidL10,
    askQtyL10: askL10,
  };
}

function makeBinanceDepthHandler({ exchange = 'binance', emit, nowMs }) {
  if (typeof emit !== 'function') throw new Error('emit must be a function');
  if (typeof nowMs !== 'function') throw new Error('nowMs must be a function');

  return function handle(raw) {
    const out = parseBinanceDepthMessage(raw);
    if (!out) return false;

    emit('md:l2', {
      tsMs: nowMs(),
      exchange,
      ...out,
    });

    return true;
  };
}

module.exports = {
  parseBinanceDepthMessage,
  makeBinanceDepthHandler,
};
