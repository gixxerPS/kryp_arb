const WebSocket = require('ws');

const log = require('../logger').getLogger('binance');
const { fmt2, nowSec } = require('../myutil');

module.exports = function (db, symbols) {
  const streams = symbols
    .map((s) => s.toLowerCase() + '@bookTicker')
    .join('/');

  const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
  const ws = new WebSocket(url);

  const lastSeenSec = new Map();

  ws.on('open', () => {
    log.info(`connected symbols=${symbols.length}`);
  });

  ws.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      const data = parsed.data;
      if (!data || !data.s) return;

      const symbol = data.s; // already normalized (BTCUSDT)
      const sec = nowSec();

      if (lastSeenSec.get(symbol) === sec) return;
      lastSeenSec.set(symbol, sec);

      await db.query(
        `INSERT INTO bbo_ticks
         (ts, exchange, symbol, bid, bid_size, ask, ask_size)
         VALUES (to_timestamp($1 / 1000.0), 'binance', $2, $3, $4, $5, $6);`,
        [
          Date.now(),
          symbol,
          Number(data.b),
          Number(data.B),
          Number(data.a),
          Number(data.A),
        ]
      );
      log.debug(`saved ${symbol} bid=${fmt2(data.b)} ask=${fmt2(data.a)}`);
    } catch (err) {
      log.error('message error: ', err);
    }
  });

  ws.on('close', () => {
    log.warn('disconnected');
  });

  ws.on('error', (err) => {
    log.error('ws error: ', err);
  });
};

