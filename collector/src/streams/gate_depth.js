// collector/src/streams/gate_depth.js
const WebSocket = require('ws');

const log = require('../logger').getLogger('gate_depth');
const { nowSec, symFromExchange } = require('../myutil');

function sumQty(levels, n) {
  let s = 0;
  const lim = Math.min(levels.length, n);
  for (let i = 0; i < lim; i += 1) {
    const qty = Number(levels[i][1]);
    if (Number.isFinite(qty)) s += qty;
  }
  return s;
}

module.exports = function (db, symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error('symbols must be non-empty array');
  }

  const ws = new WebSocket('wss://api.gateio.ws/ws/v4/');
  const lastSeenSec = new Map(); // symbol -> sec

  ws.on('open', () => {
    log.info(`connected symbols=${symbols.length}`);

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

    log.info('subscribed');
  });

  ws.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());

      if (parsed.event !== 'update') return;
      if (parsed.channel !== 'spot.order_book') return;
      if (!parsed.result) return;

      const r = parsed.result;
      const symbol = symFromExchange(r.s); // Gate sends BTC_USDT already; normalisieren auf uppercase
      const bids = Array.isArray(r.bids) ? r.bids : [];
      const asks = Array.isArray(r.asks) ? r.asks : [];

      if (bids.length === 0 || asks.length === 0) return;

      const bestBid = Number(bids[0][0]);
      const bestAsk = Number(asks[0][0]);
      const bidL1 = Number(bids[0][1]);
      const askL1 = Number(asks[0][1]);

      if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
      if (!Number.isFinite(bidL1) || !Number.isFinite(askL1)) return;

      // Downsample auf 1 Hz pro Symbol
      const sec = nowSec();
      if (lastSeenSec.get(symbol) === sec) return;
      lastSeenSec.set(symbol, sec);

      const bidL10 = sumQty(bids, 10);
      const askL10 = sumQty(asks, 10);

      await db.query(
        `INSERT INTO orderbook_depth
         (ts, exchange, symbol, best_bid, best_ask, bid_qty_l1, ask_qty_l1, bid_qty_l10, ask_qty_l10)
         VALUES (to_timestamp($1 / 1000.0), 'gate', $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (ts, exchange, symbol) DO UPDATE SET
           best_bid=EXCLUDED.best_bid,
           best_ask=EXCLUDED.best_ask,
           bid_qty_l1=EXCLUDED.bid_qty_l1,
           ask_qty_l1=EXCLUDED.ask_qty_l1,
           bid_qty_l10=EXCLUDED.bid_qty_l10,
           ask_qty_l10=EXCLUDED.ask_qty_l10;`,
        [
          Number(r.t ?? Date.now()),
          symbol,
          bestBid,
          bestAsk,
          bidL1,
          askL1,
          bidL10,
          askL10,
        ],
      );

      log.debug(`saved ${symbol} bid=${bestBid} ask=${bestAsk} l10b=${bidL10} l10a=${askL10}`);
    } catch (err) {
      log.error('message error', err);
    }
  });

  ws.on('close', (code, reason) => {
    log.warn(`disconnected code=${code} reason=${reason ? reason.toString() : ''}`);
  });

  ws.on('error', (err) => {
    log.error('ws error', err);
  });
};

