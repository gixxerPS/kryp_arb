// bot/src/collector/parsers/bitget_depth.js
//
// Contains:
// - parseBitgetDepthMessage(raw): parse/normalize a Bitget books (L2) update message
// - makeBitgetDepthHandler({ exchange, emit, nowMs }): builds a handler that emits md:l2
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

function isBooksChannel(ch) {
  if (typeof ch !== 'string') return false;
  // Bitget commonly uses: books / books5 / books15
  return ch === 'books' || ch === 'books5' || ch === 'books15' || ch.startsWith('books');
}

function parseBitgetDepthMessage(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed) return null;

  // We only want order book messages.
  const arg = parsed.arg;
  if (!arg) return null;

  if (!isBooksChannel(arg.channel)) return null;

  // Bitget uses action: "snapshot" | "update" (sometimes other values)
  if (parsed.action !== 'snapshot' && parsed.action !== 'update') return null;

  const instId = arg.instId;
  if (!instId) return null;

  const dataArr = Array.isArray(parsed.data) ? parsed.data : [];
  if (dataArr.length === 0) return null;

  // We take the first entry; Bitget often sends one element per message.
  const d = dataArr[0];
  if (!d) return null;

  const bids = Array.isArray(d.bids) ? d.bids : [];
  const asks = Array.isArray(d.asks) ? d.asks : [];
  if (bids.length === 0 || asks.length === 0) return null;

  const symbol = symFromExchange(instId);

  const bestBid = Number(bids[0][0]);
  const bestAsk = Number(asks[0][0]);
  const bidL1 = Number(bids[0][1]);
  const askL1 = Number(asks[0][1]);

  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
  if (!Number.isFinite(bidL1) || !Number.isFinite(askL1)) return null;

  const bidL10 = sumQty(bids, 10);
  const askL10 = sumQty(asks, 10);

  // Bitget provides ms timestamps as string in d.ts
  const tsMs = Number.isFinite(Number(d.ts)) ? Number(d.ts) : null;

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

function makeBitgetDepthHandler({ exchange = 'bitget', emit, nowMs }) {
  if (typeof emit !== 'function') throw new Error('emit must be a function');
  if (typeof nowMs !== 'function') throw new Error('nowMs must be a function');

  return function handle(raw) {
    const out = parseBitgetDepthMessage(raw);
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
  parseBitgetDepthMessage,
  makeBitgetDepthHandler,
};

