const WebSocket = require('ws');

const bus = require('../bus');
const { makeBinanceDepthHandler } = require('./parsers/binance_depth');
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

  const handler = makeBinanceDepthHandler({
    exchange: 'binance',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });

  ws.on('open', () => {
    log.info({ symbols: symbols.length, levels, updateMs }, 'connected');
  });

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      const parsed = JSON.parse(msg.toString());

      const stream = String(parsed.stream || '');
      const at = stream.indexOf('@');
      const base = at !== -1 ? stream.slice(0, at) : stream;
      const symbol = symFromExchange(base);

      const sec = nowSec();
      if (lastSeenSec.get(symbol) === sec) return;
      lastSeenSec.set(symbol, sec);

      handler(parsed);

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

