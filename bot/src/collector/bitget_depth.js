const WebSocket = require('ws');

const bus = require('../bus');
const { getLogger } = require('../logger');
const { nowSec, symFromExchange, symToBitget } = require('../util');

const log = getLogger('bitget_depth');

function sumQty(levels, n) {
  let s = 0;
  const lim = Math.min(levels.length, n);
  for (let i = 0; i < lim; i += 1) {
    const q = Number(levels[i][1]);
    if (Number.isFinite(q)) s += q;
  }
  return s;
}

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

module.exports = function startBitgetDepth(symbols, levels) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error('symbols must be non-empty array');
  }

  const ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
  const lastSeenSec = new Map(); // symbol -> sec

  startHeartbeat(ws, 20000);

  ws.on('open', () => {
    log.info({ symbols: symbols.length, levels }, 'connected');

    const channel = levels >= 15 ? 'books15' : (levels >= 5 ? 'books5' : 'books1');

    const chunkSize = 20;
    for (let i = 0; i < symbols.length; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
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

      const arg = parsed.arg || {};
      const instId = arg.instId;
      if (!instId) return;

      const symbol = symFromExchange(instId);
      const d0 = parsed.data[0];

      const bids = Array.isArray(d0.bids) ? d0.bids : [];
      const asks = Array.isArray(d0.asks) ? d0.asks : [];
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

      const tsMs = Number(d0.ts ?? parsed.ts ?? Date.now());

      bus.emit('md:l2', {
        tsMs,
        exchange: 'bitget',
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

