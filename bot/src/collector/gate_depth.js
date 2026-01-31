const WebSocket = require('ws');

const bus = require('../bus');
const { makeGateDepthHandler } = require('./parsers/gate_depth');
const { nowSec, symFromExchange, symToGate } = require('../util');

const { getCfg } = require('../config');
const cfg = getCfg();

const { getLogger } = require('../logger');
const log = getLogger('collector').child({ exchange: 'gate' });

const { getExState } = require('../common/exchange_state');
const { WS_STATE } = require('../common/constants');

function startHeartbeat(ws, intervalMs) {
  let timer = null;

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  ws.on('open', () => {
    stop();
    timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, intervalMs);
  });

  ws.on('ping', (d) => {
    try { ws.pong(d); } catch (e) { /* ignore */ }
  });

  ws.on('close', () => stop());
  ws.on('error', () => stop());
}

module.exports = function startGateDepth(levels, updateMs) {
  const ws = new WebSocket('wss://api.gateio.ws/ws/v4/');
  const lastSeenSec = new Map(); // symbol -> sec

  startHeartbeat(ws, 20000);

  const handler = makeGateDepthHandler({
    exchange: 'gate',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });

  const exState = getExState();

  ws.on('open', () => {
    exState.onWsState('gate', WS_STATE.OPEN);
    const symbols = cfg.symbols;
    log.info({ symbols: cfg.symbols.length, levels, updateMs }, 'connected');

    // spot.order_book: payload ["BTC_USDT", "10", "100ms"] for 10 levels snapshot. :contentReference[oaicite:2]{index=2}
    const chunkSize = 50;
    for (let i = 0; i < symbols.length; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
      for (const sym of chunk) {
        ws.send(JSON.stringify({
          time: Math.floor(Date.now() / 1000),
          channel: 'spot.order_book',
          event: 'subscribe',
          payload: [sym, '10', '100ms'],
        }));
      }
    }
  });

  ws.on('message', (msg) => {
    exState.onWsMessage('gate');
    try {
      const parsed = JSON.parse(msg.toString());

      if (parsed.event === 'subscribe') {
        log.info({ channel: parsed.channel, payload: parsed.payload }, 'subscribed');
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
  });

  ws.on('close', (code, reason) => {
    exState.onWsState('gate', WS_STATE.CLOSED);
    log.warn({ code, reason: reason ? reason.toString() : '' }, 'disconnected');
  });

  ws.on('error', (err) => {
    exState.onWsError('gate', e);
    log.error({ err }, 'ws error');
  });

  return ws;
};

