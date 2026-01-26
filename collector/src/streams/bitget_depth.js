// collector/src/streams/bitget_depth.js
const WebSocket = require('ws');

const log = require('../logger').getLogger('bitget_depth');
const { nowSec, symFromExchange, symToBitget } = require('../myutil');

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

  const ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
  const lastSeenSec = new Map(); // symbol -> sec

  ws.on('open', () => {
    log.info('connected');

    // Spot depth channel: books/books1/books5/books15. Use books15 to have >=10 levels. :contentReference[oaicite:3]{index=3}
    const chunkSize = 20;
    for (let i = 0; i < symbols.length; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);

      const args = chunk.map((s) => ({
        instType: 'SPOT',
        channel: 'books15',
        instId: symToBitget(s), // BTC_USDT -> BTCUSDT
      }));

      ws.send(JSON.stringify({ op: 'subscribe', args }));
    }

    log.info(`subscribed symbols=${symbols.length}`);
  });

  ws.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());

      // ignore acks
      if (parsed.event) return;
      if (!parsed.data || !Array.isArray(parsed.data) || parsed.data.length === 0) return;

      const arg = parsed.arg || {};
      const instId = arg.instId;
      if (!instId) return;

      const symbol = symFromExchange(instId); // BTCUSDT -> BTC_USDT
      const d0 = parsed.data[0];

      const bids = Array.isArray(d0.bids) ? d0.bids : [];
      const asks = Array.isArray(d0.asks) ? d0.asks : [];
      if (bids.length === 0 || asks.length === 0) return;

      const bestBid = Number(bids[0][0]);
      const bestAsk = Number(asks[0][0]);
      const bidL1 = Number(bids[0][1]);
      const askL1 = Number(asks[0][1]);

      if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
      if (!Number.isFinite(bidL1) || !Number.isFinite(askL1)) return;

      // Downsample 1 Hz pro Symbol
      const sec = nowSec();
      if (lastSeenSec.get(symbol) === sec) return;
      lastSeenSec.set(symbol, sec);

      const bidL10 = sumQty(bids, 10);
      const askL10 = sumQty(asks, 10);

      const tsMs = Number(d0.ts ?? parsed.ts ?? Date.now());

      await db.query(
        `INSERT INTO orderbook_depth
         (ts, exchange, symbol, best_bid, best_ask, bid_qty_l1, ask_qty_l1, bid_qty_l10, ask_qty_l10)
         VALUES (to_timestamp($1 / 1000.0), 'bitget', $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (ts, exchange, symbol) DO UPDATE SET
           best_bid=EXCLUDED.best_bid,
           best_ask=EXCLUDED.best_ask,
           bid_qty_l1=EXCLUDED.bid_qty_l1,
           ask_qty_l1=EXCLUDED.ask_qty_l1,
           bid_qty_l10=EXCLUDED.bid_qty_l10,
           ask_qty_l10=EXCLUDED.ask_qty_l10;`,
        [
          tsMs,
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

