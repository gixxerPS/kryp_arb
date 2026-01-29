// bot/src/collector/parsers/gate_depth.js
//
// Contains:
// - parseGateDepthMessage(raw): parse/normalize a Gate spot.order_book update message
// - makeGateDepthHandler({ exchange, emit, nowMs }): builds a handler that emits md:l2
//
const { symFromExchange } = require('../../util');

const { getLogger } = require('../../logger');
const log = getLogger('collector').child({ exchange: 'gate', sub:'parser' });

function parseGateDepthMessage(parsed) {
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

  // Gate provides seconds timestamps in r.t (not always present)
  const tsMs = Number.isFinite(Number(r.t)) ? Number(r.t) * 1000 : null;

  return {
    tsMs,
    symbol,
    bids,
    asks
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
      bids: out.bids,
      asks: out.asks
    });
    return true;
  };
}

module.exports = {
  parseGateDepthMessage,
  makeGateDepthHandler,
};

