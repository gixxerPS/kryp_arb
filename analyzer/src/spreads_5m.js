// analyzer/src/spreads_5m.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Client } = require('pg');
const log = require('./logger').getLogger('app');

/* =========================
   Parameters
   ========================= */

const PERIOD = '24 hours'; //'5 minutes';
const BIN_SECONDS = 1;      // 1 = 1s bins, 2 = 2s bins, ...
const TOP_N = 50;
const MIN_SAMPLES = 10;

/* ========================= */

function binExpr(seconds) {
  if (seconds <= 1) return `date_trunc('second', ts)`;
  return `to_timestamp(floor(extract(epoch FROM ts) / ${seconds}) * ${seconds})`;
}

function toEpochSec(ts) {
  return Math.floor(new Date(ts).getTime() / 1000);
}

function spreadOf(row) {
  return (row.sell_bid - row.buy_ask) / row.buy_ask;
}

function keyOf(row) {
  return `${row.symbol}|${row.buy_ex}|${row.sell_ex}`;
}

async function main() {
  const db = new Client({ connectionString: process.env.POSTGRES_URL });
  await db.connect();

  console.log('\n=== Parameters ===');
  console.log({
    period: PERIOD,
    bin_seconds: BIN_SECONDS,
    top_n: TOP_N,
    min_samples: MIN_SAMPLES,
  });

  const q = `
    WITH w AS (
      SELECT ${binExpr(BIN_SECONDS)} AS t, exchange, symbol, bid, ask
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
    ORDER BY symbol, buy_ex, sell_ex, t;
  `;

  const res = await db.query(q);
  const rows = res.rows;

  const groups = new Map();

  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);

    groups.get(k).push({
      t: r.t,
      symbol: r.symbol,
      buy_ex: r.buy_ex,
      sell_ex: r.sell_ex,
      buy_ask: Number(r.buy_ask),
      sell_bid: Number(r.sell_bid),
    });
  }

  const out = [];

  for (const arr of groups.values()) {
    if (arr.length < MIN_SAMPLES) continue;

    let maxSpread = -Infinity;
    let maxT = null;

    for (const row of arr) {
      const s = spreadOf(row);
      if (s > maxSpread) {
        maxSpread = s;
        maxT = row.t;
      }
    }

    // Streak in seconds (bin-based)
    const step = BIN_SECONDS; // consecutive bins differ by BIN_SECONDS seconds
    let bestLen = 0;
    let curLen = 0;
    let prev = null;

    for (const row of arr) {
      const s = spreadOf(row);
      const sec = toEpochSec(row.t);

      // exact max spread is fragile; require "within EPS"
      const EPS = 1e-12;
      const isMax = Math.abs(s - maxSpread) <= EPS;

      if (!isMax) {
        if (curLen > bestLen) bestLen = curLen;
        curLen = 0;
        prev = sec;
        continue;
      }

      if (curLen === 0) {
        curLen = 1;
      } else {
        if (prev !== null && sec === prev + step) {
          curLen += 1;
        } else {
          if (curLen > bestLen) bestLen = curLen;
          curLen = 1;
        }
      }

      prev = sec;
    }

    if (curLen > bestLen) bestLen = curLen;

    const sample = arr[0];

    out.push({
      symbol: sample.symbol,
      buy_ex: sample.buy_ex,
      sell_ex: sample.sell_ex,
      samples: arr.length,
      max_raw_spread: maxSpread,
      max_raw_spread_pct: maxSpread * 100.0,
      max_streak_bins: bestLen,
      max_streak_s: bestLen * BIN_SECONDS,
      max_at: maxT,
    });
  }

  out.sort((a, b) => b.max_raw_spread - a.max_raw_spread);

  const display = out.slice(0, TOP_N).map((r) => ({
    symbol: r.symbol,
    buy_ex: r.buy_ex,
    sell_ex: r.sell_ex,
    samples: r.samples,
    max_raw_spread_pct: Number(r.max_raw_spread_pct.toFixed(4)),
    max_streak_s: r.max_streak_s,
    max_at: r.max_at,
  }));

  console.table(display);

  await db.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});

