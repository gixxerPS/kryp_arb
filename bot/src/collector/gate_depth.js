const WebSocket = require('ws');

const bus = require('../bus');
const { makeGateDepthHandler } = require('./parsers/gate_depth');

const { getCfg } = require('../common/config');
const cfg = getCfg();

const { getLogger } = require('../common/logger');
const log = getLogger('collector').child({ exchange: 'gate' });

const { getExState } = require('../common/exchange_state');
const { WS_STATE } = require('../common/constants');

const { createReconnectWS } = require('../common/ws_reconnect');

module.exports = function startGateDepth(levels, updateMs) {
  const handler = makeGateDepthHandler({
    exchange: 'gate',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });

  const exState = getExState();
  const url = 'wss://api.gateio.ws/ws/v4/';
  const chunkSize = 50;

  const mgr = createReconnectWS({
    name: 'gate',
    log,
    heartbeatIntervalMs: 20000,
    connect: () => {
      const ws = new WebSocket(url);
      return ws;
    },

    onOpen: async (ws) => {
      exState.onWsState('gate', WS_STATE.OPEN);
      log.info({ symbols: cfg.symbols.length, levels, updateMs }, 'connected');

      // spot.order_book: payload ["BTC_USDT", "10", "100ms"] for 10 levels snapshot. :contentReference[oaicite:2]{index=2}
      for (let i = 0; i < cfg.symbols.length; i += chunkSize) {
        const chunk = cfg.symbols.slice(i, i + chunkSize);
        for (const sym of chunk) {
          ws.send(JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            channel: 'spot.order_book',
            event: 'subscribe',
            payload: [sym, '10', '100ms'],
          }));
        }
      }
    },

    onMessage: (msg) => {
      exState.onWsMessage('gate');
      try {
        const parsed = JSON.parse(msg.toString());

        if (parsed.event === 'subscribe') {
          log.debug({ channel: parsed.channel, payload: parsed.payload }, 'subscribed');
          return;
        }

        if (parsed.event === 'error') {
          log.error({ parsed }, 'subscribe error');
          return;
        }

        if (parsed.event !== 'update') return;
        if (parsed.channel !== 'spot.order_book') return;
        if (!parsed.result) return;

        handler(parsed);
      } catch (e) {
        log.error({ err: e }, 'message error');
      }
    },

    onReconnect: () => {
      exState.onWsReconnect('gate'); // zaehlt reconnects + speichert meta
    },

    onClose: (code, reason) => {
      exState.onWsState('gate', WS_STATE.CLOSED);
    },

    onError: (err) => {
      exState.onWsError('gate', err);
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

