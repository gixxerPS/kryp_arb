const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Client } = require('pg');
const log = require('./logger').getLogger('app');

const PERIOD = '24 days';
const TOP_ROUTES = 10;
const RECENT_LIMIT = 10;

function num(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

async function main() {
  const db = new Client({ connectionString: process.env.POSTGRES_URL });
  await db.connect();

  console.log('\n=== Parameters ===');
  console.log({
    period: PERIOD,
    top_routes: TOP_ROUTES,
    recent_limit: RECENT_LIMIT,
  });

  const routesQ = `
    SELECT
      symbol,
      buy_ex,
      sell_ex,
      COUNT(*)::int AS intents,
      AVG(expected_pnl_quote) AS avg_pnl_quote,
      SUM(expected_pnl_quote) AS sum_pnl_quote,
      AVG(expected_pnl_bps) AS avg_pnl_bps,
      AVG(target_qty) AS avg_target_qty,
      MAX(ts) AS last_seen
    FROM trade_intent
    WHERE ts >= now() - interval '${PERIOD}'
    GROUP BY symbol, buy_ex, sell_ex
    ORDER BY sum_pnl_quote DESC, intents DESC
    LIMIT ${TOP_ROUTES};
  `;

  const recentQ = `
    SELECT
      ts,
      symbol,
      buy_ex,
      sell_ex,
      expected_pnl_quote,
      expected_pnl_bps,
      buy_quote,
      sell_quote,
      target_qty
    FROM trade_intent
    WHERE ts >= now() - interval '${PERIOD}'
    ORDER BY ts DESC
    LIMIT ${RECENT_LIMIT};
  `;

  const [routesRes, recentRes] = await Promise.all([
    db.query(routesQ),
    db.query(recentQ),
  ]);





  console.log('\n=== Top Routes ===');
  console.table(routesRes.rows.map((row) => ({
    symbol: row.symbol,
    buy_ex: row.buy_ex,
    sell_ex: row.sell_ex,
    intents: row.intents,
    sum_pnl_quote: num(row.sum_pnl_quote, 4),
    avg_pnl_quote: num(row.avg_pnl_quote, 4),
    avg_pnl_bps: num(row.avg_pnl_bps, 2),
    avg_target_qty: num(row.avg_target_qty, 6),
    last_seen: row.last_seen,
  })));

  // console.log('\n=== Recent Intents ===');
  // console.table(recentRes.rows.map((row) => ({
  //   ts: row.ts,
  //   symbol: row.symbol,
  //   buy_ex: row.buy_ex,
  //   sell_ex: row.sell_ex,
  //   pnl_quote: num(row.expected_pnl_quote, 4),
  //   pnl_bps: num(row.expected_pnl_bps, 2),
  //   buy_quote: num(row.buy_quote, 4),
  //   sell_quote: num(row.sell_quote, 4),
  //   target_qty: num(row.target_qty, 6),
  // })));

  await db.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
