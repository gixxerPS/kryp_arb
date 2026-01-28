const WebSocket = require('ws');

const bus = require('../bus');
const { nowSec, symFromExchange, sumQty } = require('../util');

const { getCfg } = require('../config');
const cfg = getCfg();

const { getLogger } = require('../logger');
const log = getLogger('gate_depth');

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

  ws.on('open', () => {
    log.info({ symbols: cfg.symbols.length, levels, updateMs }, 'connected');
    for (const sym of cfg.symbols) {
      ws.send(JSON.stringify({
        time: Math.floor(Date.now() / 1000),
        channel: 'spot.order_book',
        event: 'subscribe',
        payload: [sym, String(levels), `${updateMs}ms`],
      }));
    }
  });

  ws.on('message', (msg) => {
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

      const r = parsed.result;
      const symbol = symFromExchange(r.s);
      const bids = Array.isArray(r.bids) ? r.bids : [];
      const asks = Array.isArray(r.asks) ? r.asks : [];
      if (bids.length === 0 || asks.length === 0) return;

      const sec = nowSec();
      if (lastSeenSec.get(symbol) === sec) return;
      lastSeenSec.set(symbol, sec);

      const bestBid = Number(bids[0][0]);
      const bestAsk = Number(asks[0][0]);
      const bidL1 = Number(bids[0][1]);
      const askL1 = Number(asks[0][1]);

      if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
      if (!Number.isFinite(bidL1) || !Number.isFinite(askL1)) return;

      const bidL10 = sumQty(bids, 10);
      const askL10 = sumQty(asks, 10);

      bus.emit('md:l2', {
        tsMs: Number(r.t ? r.t * 1000 : Date.now()),
        exchange: 'gate',
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

