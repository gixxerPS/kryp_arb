const WebSocket = require('ws');

const bus = require('../bus');
const { makeBitgetDepthHandler } = require('./parsers/bitget_depth');
const { symToBitget } = require('../common/util');

const { getCfg } = require('../common/config');
const cfg = getCfg();

const { getLogger } = require('../common/logger');
const log = getLogger('collector').child({ exchange: 'bitget' });

const { getExState } = require('../common/exchange_state');
const { WS_STATE } = require('../common/constants');

const { createReconnectWS } = require('../common/ws_reconnect');

module.exports = function startBitgetDepth(levels) {
  const handler = makeBitgetDepthHandler({
    exchange: 'bitget',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });

  const exState = getExState();
  const url = 'wss://ws.bitget.com/v2/ws/public';
  const channel = levels >= 15 ? 'books15' : (levels >= 5 ? 'books5' : 'books1');
  const chunkSize = 20;

  const mgr = createReconnectWS({
    name: 'bitget:depth',
    log,
    heartbeatIntervalMs : 20000,
    connect: () => {
      const ws = new WebSocket(url);
      return ws;
    },

    onOpen: async (ws) => {
      log.info({ symbols: cfg.symbols.length, levels }, 'connected');
      exState.onWsState('bitget', WS_STATE.OPEN);

      for (let i = 0; i < cfg.symbols.length; i += chunkSize) {
        const chunk = cfg.symbols.slice(i, i + chunkSize);
        const args = chunk.map((s) => ({
          instType: 'SPOT',
          channel,
          instId: symToBitget(s),
        }));
        ws.send(JSON.stringify({ op: 'subscribe', args }));
      }
    },

    onMessage: (msg) => {
      exState.onWsMessage('bitget');
      try {
        const msgStr = msg.toString();
        if (msgStr === 'pong') return;
        const parsed = JSON.parse(msgStr);
        if (parsed.event === 'subscribe') {
          log.info({ arg: parsed.arg }, 'subscribed');
          return;
        }
        if (parsed.event === 'error') {
          log.error({ parsed }, 'subscribe error');
          return;
        }
        if (!parsed.data || !Array.isArray(parsed.data) || parsed.data.length === 0) {
          return;
        }
        handler(parsed);
      } catch (e) {
        log.error({ err: e }, 'message error');
      }
    },

    onReconnect: () => {
      exState.onWsReconnect('bitget'); // zaehlt reconnects + speichert meta
    },

    onClose: (code, reason) => {
      exState.onWsState('bitget', WS_STATE.CLOSED);
    },

    onError: (err) => {
      exState.onWsError('bitget', err);
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

