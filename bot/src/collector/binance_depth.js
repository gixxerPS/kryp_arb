const WebSocket = require('ws');

const bus = require('../bus');
const { symFromExchange, symToBinance, nowSec, sumQty } = require('../util');

const { getCfg } = require('../config');
const cfg = getCfg();

const { getLogger } = require('../logger');
const log = getLogger('collector').child({ exchange: 'binance' });

const { makeBinanceDepthHandler } = require('./parsers/binance_depth');
const { getExState } = require('../common/exchange_state');
const { WS_STATE } = require('../common/constants');

module.exports = function startBinanceDepth(levels, updateMs) {
  const streams = cfg.symbols.map((s) => `${symToBinance(s)}@depth${levels}@${updateMs}ms`);
  const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;

  const ws = new WebSocket(url);
  const lastSeenSec = new Map(); // symbol -> sec

  const handler = makeBinanceDepthHandler({
    exchange: 'binance',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });

  const exState = getExState();

  ws.on('open', () => {
    exState.onWsState('binance', WS_STATE.OPEN);
    log.info({ symbols: cfg.symbols.length, levels, updateMs }, 'connected');
  });

  ws.on('message', (msg) => {
    exState.onWsMessage('binance');
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
    exState.onWsState('binance', WS_STATE.CLOSED);
    log.warn({ code, reason: reason ? reason.toString() : '' }, 'disconnected');
  });

  ws.on('error', (err) => {
    exState.onWsError('binance', e);
    log.error({ err }, 'ws error');
  });

  return ws;
};

