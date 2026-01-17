// collector/src/streams/gate.js
const WebSocket = require('ws');

const log = require('../logger').getLogger('gate');
const { fmt2, nowSec } = require('../myutil');

function toGatePair(symbol) {
  // "BTCUSDT" -> "BTC_USDT"
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4) + '_USDT';
  return symbol;
}

function fromGatePair(currencyPair) {
  // "BTC_USDT" -> "BTCUSDT"
  return currencyPair.replace('_', '');
}

module.exports = function (db, symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error('symbols must be non-empty array');
  }

  const ws = new WebSocket('wss://api.gateio.ws/ws/v4/');
  const lastSeenSec = new Map();

  ws.on('open', () => {
    log.info('connected');

    const payload = symbols.map((s) => toGatePair(s));

    ws.send(JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      channel: 'spot.tickers',
      event: 'subscribe',
      payload: payload,
    }));

    log.info(`subscribed symbols=${symbols.length}`);
  });

  ws.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());

      // Gate tickers messages have { channel, event, result, time, ... }
      if (!parsed.result || !parsed.result.currency_pair) return;

      const t = parsed.result;

      const symbol = fromGatePair(t.currency_pair);
      const sec = nowSec();

      if (lastSeenSec.get(symbol) === sec) return;
      lastSeenSec.set(symbol, sec);

      await db.query(
        `INSERT INTO bbo_ticks
         (ts, exchange, symbol, bid, bid_size, ask, ask_size)
         VALUES (to_timestamp($1 / 1000.0), 'gate', $2, $3, $4, $5, $6);`,
        [
          Date.now(),
          symbol,
          Number(t.highest_bid),
          Number(t.bid_amount),
          Number(t.lowest_ask),
          Number(t.ask_amount),
        ]
      );
      log.debug(`saved ${symbol} bid=${fmt2(t.highest_bid)} ask=${fmt2(t.lowest_ask)}`);
    } catch (err) {
      log.error('message error: ', err);
    }
  });

  ws.on('close', (code, reason) => {
    log.warn(`disconnected code=${code} reason=${reason ? reason.toString() : ''}`);
  });

  ws.on('error', (err) => {
    log.error('ws error: ', err);
  });
};

