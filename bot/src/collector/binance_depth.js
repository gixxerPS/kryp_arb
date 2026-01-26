const WebSocket = require('ws');

const bus = require('../bus');
const { getLogger } = require('../logger');
const { symFromExchange, symToBinance, nowSec } = require('../util');

const log = getLogger('binance_depth');

function sumQty(levels, n) {
  let s = 0;
  const lim = Math.min(levels.length, n);
  for (let i = 0; i < lim; i += 1) {
    const q = Number(levels[i][1]);
    if (Number.isFinite(q)) s += q;
  }
  return s;
}

module.exports = function startBinanceDepth(symbols, levels, updateMs) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error('symbols must be non-empty array');
  }

  const streams = symbols.map((s) => `${symToBinance(s)}@depth${levels}@${updateMs}ms`);
  const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;

  const ws = new WebSocket(url);
  const lastSeenSec = new Map(); // symbol -> sec

  ws.on('open', () => {
    log.info({ symbols: symbols.length, levels, updateMs }, 'connected');
  });

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (!parsed.stream || !parsed.data) return;

      const stream = String(parsed.stream);
      const at = stream.indexOf('@');
      const base = at !== -1 ? stream.slice(0, at) : stream;
      const symbol = symFromExchange(base);

      const sec = nowSec();
      if (lastSeenSec.get(symbol) === sec) return;
      lastSeenSec.set(symbol, sec);

      const bids = Array.isArray(parsed.data.bids) ? parsed.data.bids : [];
      const asks = Array.isArray(parsed.data.asks) ? parsed.data.asks : [];
      if (bids.length === 0 || asks.length === 0) return;

      const bestBid = Number(bids[0][0]);
      const bestAsk = Number(asks[0][0]);
      const bidL1 = Number(bids[0][1]);
      const askL1 = Number(asks[0][1]);

      if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
      if (!Number.isFinite(bidL1) || !Number.isFinite(askL1)) return;

      const bidL10 = sumQty(bids, 10);
      const askL10 = sumQty(asks, 10);

      bus.emit('md:l2', {
        tsMs: Date.now(),
        exchange: 'binance',
        symbol,
        bestBid,
        bestAsk,
        bidQtyL1: bidL1,
        askQtyL1: askL1,
        bidQtyL10: bidL10,
        askQtyL10: askL10,
      });
    } catch (e) {
      log.error({ err: e }, 'message error');
    }
  });

  ws.on('close', (code, reason) => {
    log.warn({ code, reason: reason ? reason.toString() : '' }, 'disconnected');
  });

  ws.on('error', (err) => {
    log.error({ err }, 'ws error');
  });

  return ws;
};

