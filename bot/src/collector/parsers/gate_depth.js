// bot/src/collector/parsers/gate_depth.js
//
// Contains:
// - parseGateDepthMessage(raw): parse/normalize a Gate spot.order_book update message
// - makeGateDepthHandler({ exchange, emit, nowMs }): builds a handler that emits md:l2
//
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

function parseGateDepthMessage(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed) return null;

  // Gate sends different event types; we only want order_book updates.
  if (parsed.channel !== 'spot.order_book') return null;
  if (parsed.event !== 'update') return null;

  const r = parsed.result;
  if (!r) return null;

  const symbol = symFromExchange(r.s);

  const bids = Array.isArray(r.bids) ? r.bids : [];
  const asks = Array.isArray(r.asks) ? r.asks : [];
  if (bids.length === 0 || asks.length === 0) return null;

  const bestBid = Number(bids[0][0]);
  const bestAsk = Number(asks[0][0]);
  const bidL1 = Number(bids[0][1]);
  const askL1 = Number(asks[0][1]);

  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
  if (!Number.isFinite(bidL1) || !Number.isFinite(askL1)) return null;

  const bidL10 = sumQty(bids, 10);
  const askL10 = sumQty(asks, 10);

  // Gate provides seconds timestamps in r.t (not always present)
  const tsMs = Number.isFinite(Number(r.t)) ? Number(r.t) * 1000 : null;

  return {
    tsMs,
    symbol,
    bestBid,
    bestAsk,
    bidQtyL1: bidL1,
    askQtyL1: askL1,
    bidQtyL10: bidL10,
    askQtyL10: askL10,
  };
}

function makeGateDepthHandler({ exchange = 'gate', emit, nowMs }) {
  if (typeof emit !== 'function') throw new Error('emit must be a function');
  if (typeof nowMs !== 'function') throw new Error('nowMs must be a function');

  return function handle(raw) {
    const out = parseGateDepthMessage(raw);
    if (!out) return false;

    emit('md:l2', {
      tsMs: out.tsMs != null ? out.tsMs : nowMs(),
      exchange,
      symbol: out.symbol,
      bestBid: out.bestBid,
      bestAsk: out.bestAsk,
      bidQtyL1: out.bidQtyL1,
      askQtyL1: out.askQtyL1,
      bidQtyL10: out.bidQtyL10,
      askQtyL10: out.askQtyL10,
    });

    return true;
  };
}

module.exports = {
  parseGateDepthMessage,
  makeGateDepthHandler,
};

