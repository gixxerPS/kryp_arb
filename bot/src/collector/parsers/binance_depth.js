// bot/src/collector/parsers/binance_depth.js
const { symFromExchange } = require('../../util');

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

  return {
    symbol,
    bids,
    asks
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
