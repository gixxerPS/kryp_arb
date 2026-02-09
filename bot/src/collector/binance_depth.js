const WebSocket = require('ws');

const bus = require('../bus');
const { symFromExchange, symToBinance, nowSec, sumQty } = require('../common/util');

const { getCfg } = require('../common/config');
const cfg = getCfg();

const { getLogger } = require('../common/logger');
const log = getLogger('collector').child({ exchange: 'binance' });

const { makeBinanceDepthHandler } = require('./parsers/binance_depth');
const { getExState } = require('../common/exchange_state');
const { WS_STATE } = require('../common/constants');

const { createReconnectWS } = require('../common/ws_reconnect');

module.exports = function startBinanceDepth(levels, updateMs) {
  const handler = makeBinanceDepthHandler({
    exchange: 'binance',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });
  
  const exState = getExState();
  const streams = cfg.symbols.map((s) => `${symToBinance(s)}@depth${levels}@${updateMs}ms`);
  const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;

  const mgr = createReconnectWS({
    name: 'binance',
    log,
    connect: () => {
      const ws = new WebSocket(url);
      return ws;
    },
    onOpen: async (ws) => {
      exState.onWsState('binance', WS_STATE.OPEN);
      log.info({ symbols: cfg.symbols.length, levels, updateMs }, 'connected');
    },

    onMessage: (msg) => {
      exState.onWsMessage('binance');
      try {
        const parsed = JSON.parse(msg.toString());
        //log.info(parsed);
        handler(parsed);
      } catch (e) {
        log.error({ err: e }, 'message error');
      }
    },

    onReconnect: () => {
      exState.onWsReconnect('binance'); // zaehlt reconnects + speichert meta
    },

    onClose: (code, reason) => {
      exState.onWsState('binance', WS_STATE.CLOSED);
    },

    onError: (err) => {
      exState.onWsError('binance', err);
    },

    delayOverrideMs: ({ type, code, reason, err }) => {
      // 1006 abnormal closure -> try fast first.
      if (type === 'close' && code === 1006) return 1000;

      const r = (reason || '').toLowerCase();
      const e = (err?.message || '').toLowerCase();

      // Examples of longer cool-downs
      if (code === 1008 || r.includes('policy')) return 120_000;
      if (e.includes('429') || r.includes('rate')) return 90_000;
      if (code === 1013 || r.includes('try again later')) return 60_000;

      return null;
    },
  });
  mgr.start();
};

