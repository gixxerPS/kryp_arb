const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Client } = require('pg');
const { loadExchanges, feePctToFactor } = require('./exchanges');

const PERIOD = '24 hours';
const Q = 5000;           // USDT pro Trade
const SLIPPAGE = 0.0005;  // 0.05 %
const MIN_RAW = 0.003;    // 0.30 %

function rawSpread(buyAsk, sellBid) {
  return (sellBid - buyAsk) / buyAsk;
}

function pairKey(buyEx, sellEx) {
  return `${buyEx}->${sellEx}`;
}

async function main() {
  const fees = loadExchanges();
  const exchanges = Object.keys(fees);

  const db = new Client({ connectionString: process.env.POSTGRES_URL });
  await db.connect();

  const q = `
  WITH w AS (
    SELECT
      to_timestamp(floor(extract(epoch FROM ts) / 2) * 2) AS t,
      exchange,
      symbol,
      bid,
      ask
    FROM bbo_ticks
    WHERE ts > now() - interval '${PERIOD}'
  ),
  p AS (
    SELECT
      a.t,
      a.symbol,
      a.exchange AS buy_ex,
      b.exchange AS sell_ex,
      a.ask AS buy_ask,
      b.bid AS sell_bid
    FROM w a
    JOIN w b
      ON a.t = b.t
     AND a.symbol = b.symbol
     AND a.exchange <> b.exchange
  )
  SELECT
    t,
    symbol,
    buy_ex,
    sell_ex,
    buy_ask,
    sell_bid
  FROM p
  ORDER BY t;
`;


  const res = await db.query(q);
  //console.log(res.rows.length);
  //console.log(res.rows[0]);

  /**
   * stats[symbol][pair] = { trades, pnl }
   */
  const stats = new Map();

  // 1) alle symbol + paare vorinitialisieren
  for (const r of res.rows) {
    const symbol = r.symbol;

    if (!stats.has(symbol)) {
      const m = new Map();
      for (const buy of exchanges) {
        for (const sell of exchanges) {
          if (buy === sell) continue;
          m.set(pairKey(buy, sell), { trades: 0, pnl: 0 });
        }
      }
      stats.set(symbol, m);
    }
  }

  // 2) Trades simulieren
  for (const r of res.rows) {
    const raw = rawSpread(Number(r.buy_ask), Number(r.sell_bid));
    if (raw < MIN_RAW) continue;

    const buyFee = feePctToFactor(fees[r.buy_ex].taker_fee_pct);
    const sellFee = feePctToFactor(fees[r.sell_ex].taker_fee_pct);

    const net = raw - buyFee - sellFee - SLIPPAGE;
    if (net <= 0) continue;

    const m = stats.get(r.symbol);
    const s = m.get(pairKey(r.buy_ex, r.sell_ex));

    s.trades += 1;
    s.pnl += Q * net;
  }

  // 3) Ausgabe

  console.log('\n=== Simulation Parameters ===');
  console.log({
    period: PERIOD,
    trade_size_usdt: Q,
    min_raw_spread_pct: (MIN_RAW * 100).toFixed(2),
    slippage_pct: (SLIPPAGE * 100).toFixed(2),
    exchanges: exchanges,
  });

// Tabelle 1: je Symbol x Route
  const rows = [];
  for (const [symbol, m] of stats.entries()) {
    for (const [route, s] of m.entries()) {
      rows.push({
        symbol,
        route,
        trades: s.trades,
        pnl_usdt: Number(s.pnl.toFixed(2)),
        avg_usdt: s.trades > 0 ? Number((s.pnl / s.trades).toFixed(4)) : 0,
      });
    }
  }

  rows.sort((a, b) => b.pnl_usdt - a.pnl_usdt);

  console.log('\n=== PnL by Symbol x Route ===');
  console.table(rows);

  // Tabelle 2: aggregiert je Symbol (über alle Routen)
  const bySymbol = new Map(); // symbol -> { trades, pnl }

  for (const r of rows) {
    if (!bySymbol.has(r.symbol)) {
      bySymbol.set(r.symbol, { trades: 0, pnl: 0 });
    }

    const agg = bySymbol.get(r.symbol);
    agg.trades += r.trades;
    agg.pnl += r.pnl_usdt;
  }

  const symbolRows = [];

  for (const [symbol, a] of bySymbol.entries()) {
    symbolRows.push({
      symbol,
      trades: a.trades,
      pnl_usdt: Number(a.pnl.toFixed(2)),
      avg_usdt: a.trades > 0
        ? Number((a.pnl / a.trades).toFixed(4))
        : 0,
    });
  }

  symbolRows.sort((a, b) => b.pnl_usdt - a.pnl_usdt);

  console.log('\n=== PnL by Symbol (Aggregated over all routes) ===');
  console.table(symbolRows);


  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

