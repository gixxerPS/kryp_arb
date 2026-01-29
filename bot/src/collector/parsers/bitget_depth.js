// bot/src/collector/parsers/bitget_depth.js
//
// Contains:
// - parseBitgetDepthMessage(raw): parse/normalize a Bitget books (L2) update message
// - makeBitgetDepthHandler({ exchange, emit, nowMs }): builds a handler that emits md:l2
//
const { symFromExchange } = require('../../util');

const { getLogger } = require('../../logger');
const log = getLogger('collector').child({ exchange: 'bitget', sub:'parser' });

function isBooksChannel(ch) {
  if (typeof ch !== 'string') return false;
  // Bitget commonly uses: books / books5 / books15
  return ch === 'books' || ch === 'books5' || ch === 'books15' || ch.startsWith('books');
}

function parseBitgetDepthMessage(parsed) {
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

  // Bitget provides ms timestamps as string in d.ts
  const tsMs = Number.isFinite(Number(d.ts)) ? Number(d.ts) : null;

  return {
    tsMs,
    symbol,
    bids,
    asks,
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
      bids: out.bids,
      asks: out.asks,
    });

    return true;
  };
}

module.exports = {
  parseBitgetDepthMessage,
  makeBitgetDepthHandler,
};

