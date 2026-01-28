const WebSocket = require('ws');

const bus = require('../bus');
const { makeBinanceDepthHandler } = require('./parsers/binance_depth');
const { symFromExchange, symToBinance, nowSec, sumQty } = require('../util');

const { getCfg } = require('../config');
const cfg = getCfg();

const { getLogger } = require('../logger');
const log = getLogger('collector:binance_depth');

module.exports = function startBinanceDepth(levels, updateMs) {
  const streams = cfg.symbols.map((s) => `${symToBinance(s)}@depth${levels}@${updateMs}ms`);
  const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;

  log.debug({url:url}, 'subscribe');
  const ws = new WebSocket(url);
  const lastSeenSec = new Map(); // symbol -> sec

  const handler = makeBinanceDepthHandler({
    exchange: 'binance',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });

  ws.on('open', () => {
    log.info({ symbols: cfg.symbols.length, levels, updateMs }, 'connected');
  });

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());

      const stream = String(parsed.stream || '');
      const at = stream.indexOf('@');
      const base = at !== -1 ? stream.slice(0, at) : stream;
      const symbol = symFromExchange(base);

      const sec = nowSec();
      if (lastSeenSec.get(symbol) === sec) return;
      lastSeenSec.set(symbol, sec);

      //log.info(parsed);
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

