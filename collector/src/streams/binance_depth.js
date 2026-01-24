// collector/src/streams/binance_depth.js
//
// Binance L2 depth collector (Top-N levels), downsampled to 1 row / second / symbol.
// Uses the partial book stream: <symbol>@depth10@100ms or <symbol>@depth20@100ms
//
// Writes aggregated depth metrics into Postgres table: orderbook_depth
// Columns expected:
//   ts, exchange, symbol, best_bid, best_ask, bid_qty_l1, ask_qty_l1, bid_qty_l10, ask_qty_l10
//
// Notes:
// - This does NOT maintain a full local order book snapshot. It relies on Binance's partial-book stream.
// - For slippage modelling, Top-10 (or Top-20) is usually sufficient.

const WebSocket = require('ws');

const log = require('../logger').getLogger('binance_depth');
const { nowSec, fmt2, symToBinance, symFromExchange } = require('../myutil');

const EXCHANGE = 'binance';
const WS_BASE = 'wss://stream.binance.com:9443/stream?streams=';

const LEVELS = 10;          // set 10 or 20
const UPDATE_MS = 100;      // stream update speed: 100ms
const DOWNSAMPLE_SEC = 1;   // store at most 1 row/sec/symbol

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sumQty(levels, n) {
  let s = 0;
  const k = Math.min(n, levels.length);
  for (let i = 0; i < k; i += 1) {
    s += Number(levels[i][1]);
  }
  return s;
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

module.exports = function startBinanceDepth(db, symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error('symbols must be non-empty array');
  }

  // Binance requires lowercase stream names
  const streams = symbols.map((s) => `${symToBinance(s)}@depth${LEVELS}@${UPDATE_MS}ms`);

  // Keep URLs reasonable length: open multiple connections if needed
  const MAX_STREAMS_PER_WS = 200;

  const lastSeenSec = new Map(); // symbol -> last stored second

  const groups = chunk(streams, MAX_STREAMS_PER_WS);

  log.info(`starting depth collector symbols=${symbols.length} levels=${LEVELS} update=${UPDATE_MS}ms conns=${groups.length}`);

  for (let gi = 0; gi < groups.length; gi += 1) {
    const g = groups[gi];
    const url = WS_BASE + g.join('/');

    const ws = new WebSocket(url);

    ws.on('open', () => {
      log.info(`connected conn=${gi + 1}/${groups.length} streams=${g.length}`);
    });

    ws.on('message', async (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());
        //log.debug(`message: ${msg.toString()})`);
        // beispielausgabe:
        // {
        //     "stream": "metusdt@depth10@100ms",
        //     "data": {
        //       "lastUpdateId": 183132928,
        //       "bids": [
        //         ["0.2742","4193"], ["0.2741","12935.8"], ["0.2740","11667.6"],
        //         ["0.2739","25052.1"], ["0.2738","19047.7"], ["0.2737","17313.1"],
        //         ["0.2736","9567"],   ["0.2735","20070.9"], ["0.2734","9565.5"],
        //         ["0.2733","16498.2"]
        //       ],
        //       "asks": [
        //         ["0.2744","952.8"],  ["0.2745","20491"],  ["0.2746","16276.6"],
        //         ["0.2747","19001.1"],["0.2748","23212.1"],["0.2749","10154.1"],
        //         ["0.2750","16364.8"],["0.2751","13594.6"],["0.2752","21986.7"],
        //         ["0.2753","10153.5"]
        //       ]
        //     }
        //   }


        // Combined stream payload:
        // { stream: "...", data: { e:"depthUpdate", E, s:"BNBUSDT", b:[[p,q],...], a:[[p,q],...] } }
        const data = (parsed && parsed.data) ? parsed.data : null;
        if (!data) {
          //log.debug(`keine daten`);
          return;
        }

        const symbol = symFromExchange(parsed.stream.split('@',1)[0]);
        if (!symbol) {
          //log.debug(`kein symbol`);
          return;
        }

        const bids = data.bids;
        const asks = data.asks;

        if (!Array.isArray(bids) || bids.length === 0) return;
        if (!Array.isArray(asks) || asks.length === 0) return;

        const sec = nowSec();
        const last = lastSeenSec.get(symbol);
        if (last === sec) return;
        lastSeenSec.set(symbol, sec);

        const bestBid = safeNum(bids[0][0]);
        const bestAsk = safeNum(asks[0][0]);

        const bidQtyL1 = safeNum(bids[0][1]);
        const askQtyL1 = safeNum(asks[0][1]);

        if (bestBid == null || bestAsk == null || bidQtyL1 == null || askQtyL1 == null) return;

        const bidQtyL10 = sumQty(bids, 10);
        const askQtyL10 = sumQty(asks, 10);

        await db.query(
          `INSERT INTO orderbook_depth
            (ts, exchange, symbol, best_bid, best_ask, bid_qty_l1, ask_qty_l1, bid_qty_l10, ask_qty_l10)
           VALUES (to_timestamp($1), $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (ts, exchange, symbol) DO UPDATE SET
             best_bid = EXCLUDED.best_bid,
             best_ask = EXCLUDED.best_ask,
             bid_qty_l1 = EXCLUDED.bid_qty_l1,
             ask_qty_l1 = EXCLUDED.ask_qty_l1,
             bid_qty_l10 = EXCLUDED.bid_qty_l10,
             ask_qty_l10 = EXCLUDED.ask_qty_l10;`,
          [
            sec,                 // seconds epoch
            EXCHANGE,
            symbol,
            bestBid,
            bestAsk,
            bidQtyL1,
            askQtyL1,
            bidQtyL10,
            askQtyL10,
          ]
        );

        log.debug(
          `saved ${symbol} bid=${fmt2(bestBid)} ask=${fmt2(bestAsk)} ` +
          `qtyL1(b|a)=${fmt2(bidQtyL1)}|${fmt2(askQtyL1)} qtyL10(b|a)=${fmt2(bidQtyL10)}|${fmt2(askQtyL10)}`
        );
      } catch (err) {
        log.error('message error', err);
      }
    });

    ws.on('close', (code, reason) => {
      log.error(`disconnected conn=${gi + 1}/${groups.length} code=${code} reason=${reason ? reason.toString() : ''}`);
    });

    ws.on('error', (err) => {
      log.error(`ws error conn=${gi + 1}/${groups.length}`, err);
    });
  }
};

