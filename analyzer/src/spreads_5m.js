const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Client } = require('pg');
const log = require('./logger').getLogger('app');

const EPS = 1e-9;

function keyOf(row) {
  return `${row.symbol}|${row.buy_ex}|${row.sell_ex}`;
}

function spreadOf(row) {
  return (row.sell_bid - row.buy_ask) / row.buy_ask;
}

function toEpochSec(ts) {
  return Math.floor(new Date(ts).getTime() / 1000);
}

async function main() {
  const db = new Client({ connectionString: process.env.POSTGRES_URL });
  await db.connect();

  const q = `
    WITH w AS (
      SELECT date_trunc('second', ts) AS t, exchange, symbol, bid, ask
      FROM bbo_ticks
      WHERE ts > now() - interval '24 hours'
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
    if (!groups.has(k)) {
      groups.set(k, []);
    }

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

  for (const [k, arr] of groups.entries()) {
    if (arr.length < 10) continue;

    // 1) max spread finden
    let maxSpread = -Infinity;
    let maxT = null;

    for (const row of arr) {
      const s = spreadOf(row);
      if (s > maxSpread) {
        maxSpread = s;
        maxT = row.t;
      }
    }

    // 2) Dauer (längste zusammenhängende Sequenz), in der spread ~ maxSpread
    // Wir arbeiten auf Sekundenbasis (t ist date_trunc('second')).
    let bestLen = 0;
    let bestStart = null;
    let bestEnd = null;

    let curLen = 0;
    let curStart = null;
    let prevSec = null;

    for (const row of arr) {
      const s = spreadOf(row);
      const sec = toEpochSec(row.t);

      const isMax = Math.abs(s - maxSpread) <= EPS;

      if (!isMax) {
        if (curLen > bestLen) {
          bestLen = curLen;
          bestStart = curStart;
          bestEnd = prevSec;
        }
        curLen = 0;
        curStart = null;
        prevSec = sec;
        continue;
      }

      if (curLen === 0) {
        curStart = sec;
        curLen = 1;
      } else {
        if (prevSec !== null && sec === prevSec + 1) {
          curLen += 1;
        } else {
          // Gap -> Sequenz neu starten
          if (curLen > bestLen) {
            bestLen = curLen;
            bestStart = curStart;
            bestEnd = prevSec;
          }
          curStart = sec;
          curLen = 1;
        }
      }

      prevSec = sec;
    }

    if (curLen > bestLen) {
      bestLen = curLen;
      bestStart = curStart;
      bestEnd = prevSec;
    }

    const firstTs = arr[0].t;
    const lastTs = arr[arr.length - 1].t;

    const sample = arr[0];

    out.push({
      symbol: sample.symbol,
      buy_ex: sample.buy_ex,
      sell_ex: sample.sell_ex,
      samples: arr.length,
      max_raw_spread: maxSpread,
      max_raw_spread_pct: maxSpread * 100.0,
      max_at: maxT,
      max_streak_s: bestLen,
      window_first: firstTs,
      window_last: lastTs,
      max_streak_start_utc: bestStart ? new Date(bestStart * 1000).toISOString() : null,
      max_streak_end_utc: bestEnd ? new Date(bestEnd * 1000).toISOString() : null,
    });
  }

  out.sort((a, b) => b.max_raw_spread - a.max_raw_spread);

  // Anzeige: Prozent auf 3 Stellen runden
  const display = out.slice(0, 50).map((r) => ({
    symbol: r.symbol,
    buy_ex: r.buy_ex,
    sell_ex: r.sell_ex,
    samples: r.samples,
    max_raw_spread_pct: Number(r.max_raw_spread_pct.toFixed(3)),
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

