// collector/src/streams/bitget.js
const WebSocket = require('ws');

const log = require('../logger').getLogger('bitget');
const { fmt2, nowSec, symToBitget, symFromExchange } = require('../myutil');

let pingTimer = null;

module.exports = function (db, symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error('symbols must be non-empty array');
  }

  const wanted = new Set(symbols);

  const ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
  const lastSeenSec = new Map();

  ws.on('open', () => {
    log.info('connected');

    // Heartbeat: Bitget erwartet alle ~30s ein "ping"
    pingTimer = setInterval(() => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('ping');
        }
      } catch (err) {
        log.warn('ping failed');
      }
    }, 29000);

    // Subscribe in chunks
    const chunkSize = 20;
    for (let i = 0; i < symbols.length; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);

      const args = chunk.map((s) => ({
        instType: 'SPOT',
        channel: 'ticker',
        instId: symToBitget(s), // BTC_USDT -> BTCUSDT
      }));

      ws.send(JSON.stringify({
        op: 'subscribe',
        args: args,
      }));
    }

    log.info(`subscribed symbols=${symbols.length}`);
  });

  ws.on('message', async (msg) => {
    try {
      const text = msg.toString();

      // Heartbeat response
      if (text === 'pong') return;

      const parsed = JSON.parse(text);
      ////log.debug(`received: ${text}`);

      // Ignore subscribe acks / events
      if (parsed.event) return;

      if (!parsed.data || !Array.isArray(parsed.data) || parsed.data.length === 0) {
        return;
      }

      const t = parsed.data[0];
      const instId = symFromExchange(t.instId); // BTCUSDT -> BTC_USDT

      if (!instId || !wanted.has(instId)) return;

      const symbol = instId;
      const sec = nowSec();

      if (lastSeenSec.get(symbol) === sec) return;
      lastSeenSec.set(symbol, sec);

      const bid = t.bidPr ?? t.bid;
      const ask = t.askPr ?? t.ask;
      const bidSz = t.bidSz ?? t.bestBidSize ?? null;
      const askSz = t.askSz ?? t.bestAskSize ?? null;

      if (bid == null || ask == null) return;

      await db.query(
        `INSERT INTO bbo_ticks
         (ts, exchange, symbol, bid, bid_size, ask, ask_size)
         VALUES (to_timestamp($1 / 1000.0), 'bitget', $2, $3, $4, $5, $6);`,
        [
          Date.now(),
          symbol,
          Number(bid),
          bidSz == null ? null : Number(bidSz),
          Number(ask),
          askSz == null ? null : Number(askSz),
        ]
      );

      log.debug(`saved ${symbol} bid=${fmt2(bid)} ask=${fmt2(ask)}`);
    } catch (err) {
      log.error('message error', err);
    }
  });

  ws.on('close', (code, reason) => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    log.warn(`disconnected code=${code} reason=${reason ? reason.toString() : ''}`);
  });

  ws.on('error', (err) => {
    log.error('ws error', err);
  });
};

