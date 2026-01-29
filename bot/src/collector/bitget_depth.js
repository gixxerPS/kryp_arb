const WebSocket = require('ws');

const bus = require('../bus');
const { makeBitgetDepthHandler } = require('./parsers/bitget_depth');
const { nowSec, symFromExchange, symToBitget } = require('../util');

const { getCfg } = require('../config');
const cfg = getCfg();

const { getLogger } = require('../logger');
const log = getLogger('collector').child({ exchange: 'bitget' });

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

module.exports = function startBitgetDepth(levels) {
  const ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
  const lastSeenSec = new Map(); // symbol -> sec

  startHeartbeat(ws, 20000);

  const handler = makeBitgetDepthHandler({
    exchange: 'bitget',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });

  ws.on('open', () => {
    log.info({ symbols: cfg.symbols.length, levels }, 'connected');

    const channel = levels >= 15 ? 'books15' : (levels >= 5 ? 'books5' : 'books1');

     // Spot depth channel: books/books1/books5/books15. Use books15 to have >=10 levels.
    const chunkSize = 20;
    for (let i = 0; i < cfg.symbols.length; i += chunkSize) {
      const chunk = cfg.symbols.slice(i, i + chunkSize);
      const args = chunk.map((s) => ({
        instType: 'SPOT',
        channel,
        instId: symToBitget(s),
      }));
      ws.send(JSON.stringify({ op: 'subscribe', args }));
    }
  });

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());

      if (parsed.event === 'subscribe') {
        log.info({ arg: parsed.arg }, 'subscribed');
        return;
      }

      if (parsed.event === 'error') {
        log.error({ parsed }, 'subscribe error');
        return;
      }

      if (!parsed.data || !Array.isArray(parsed.data) || parsed.data.length === 0) return;
      
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

