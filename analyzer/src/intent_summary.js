const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Client } = require('pg');
const log = require('./logger').getLogger('app');

const PERIOD = '20 days';
const TOP_ROUTES = 10;
const RECENT_LIMIT = 10;

function num(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}
function percentile(arr, p) {
  if (!arr.length) return null;

  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p * sorted.length) - 1;

  return sorted[Math.max(0, idx)];
}

/**
 * kumulieren wieviel kapital benoetigt wird.
 * das entspricht dem was mindestens je boerse vorgehalten werden muss(te).
 * laufen die trades zb 100x von binance nach gate ist eine boerse irgendwann
 * leer und die andere voll.
 */
function analyzeRequiredCapital(intents) {
  // Map<symbol, Map<exchange, state>>
  const symMap = new Map();
  const pnlBySymbolMap = new Map();
  const imbalanceSeriesBySymbol = new Map();

  function getExchangeState(symbol, ex) {
    if (!symMap.has(symbol)) {
      symMap.set(symbol, new Map());
    }
    const entry = symMap.get(symbol);
    if (!entry.has(ex)) {
      entry.set(ex, {
        cum_quote: 0,     // kumuliert ueber zeit
        cum_qty: 0,       // evtl spaeter auch base qty tracken
        max_cum_quote: 0, // maximaler ausschlag (verkaufen)
        min_cum_quote: 0, // maximaler ausschlag (kaufen)
        intents_as_buy_ex: 0,
        intents_as_sell_ex: 0,
      });
    }
    return entry.get(ex);
  }

  for (const row of intents) {
    //===================================================================
    // pnl map updaten
    //===================================================================
    const pnl = Number(row.expected_pnl_quote) || 0;
    pnlBySymbolMap.set(row.symbol, (pnlBySymbolMap.get(row.symbol) || 0) + pnl);

    //===================================================================
    // cum quote map updaten
    //===================================================================
    const b = getExchangeState(row.symbol, row.buy_ex);
    const s = getExchangeState(row.symbol, row.sell_ex);

    // Quote fliesst von buy_ex weg
    b.cum_quote -= Number(row.buy_quote) || 0;
    b.intents_as_buy_ex += 1;
    if (b.cum_quote > b.max_cum_quote) {
      b.max_cum_quote = b.cum_quote;
    }
    if (b.cum_quote < b.min_cum_quote) {
      b.min_cum_quote = b.cum_quote;
    }
    
    // Quote fliesst zu sell_ex hin
    s.cum_quote += Number(row.sell_quote) || 0;
    s.intents_as_sell_ex += 1;
    if (s.cum_quote > s.max_cum_quote) {
      s.max_cum_quote = s.cum_quote;
    }
    if (s.cum_quote < s.min_cum_quote) {
      s.min_cum_quote = s.cum_quote;
    }

    //===================================================================
    // cum quote map updaten
    //===================================================================
    if (!imbalanceSeriesBySymbol.has(row.symbol)) {
      imbalanceSeriesBySymbol.set(row.symbol, []);
    }
    const exMap = symMap.get(row.symbol);
    // aktueller imbalance über alle exchanges dieses symbols
    let currentImbalance = 0;
    for (const s of exMap.values()) {
      const v = Math.abs(Number(s.cum_quote) || 0);
      if (v > currentImbalance) currentImbalance = v;
    }
    imbalanceSeriesBySymbol.get(row.symbol).push(currentImbalance);
  }

  const intervalDays = 
  (new Date(intents[intents.length-1].ts) - new Date(intents[0].ts)) / (24 * 3600 * 1000);
  const resultObj = {};
  for (const [symbol, exMap] of symMap) {
    if (!resultObj[symbol]) {
      resultObj[symbol] = { symbol };
    }
    const row = resultObj[symbol];
    let maxImbalance = 0.0; // ueber alle exchanges
    let numIntents = 0; // ueber alle exchanges
    for (const [exchange, s] of exMap) {
      row[exchange] = num(s.cum_quote, 2);
      maxImbalance = Math.max(Math.abs(s.min_cum_quote), Math.abs(s.max_cum_quote), maxImbalance);
      numIntents += s.intents_as_sell_ex + s.intents_as_buy_ex;
    }
    const pnl = pnlBySymbolMap.get(symbol);
    const series = imbalanceSeriesBySymbol.get(symbol) || [];
    const p95Imbalance = percentile(series, 0.95);
    row.capEff = p95Imbalance > 0 ? num(pnl / p95Imbalance, 4) : null;
    row.pnl = num(pnl, 2);
    // row.maxImbalance = num(maxImbalance, 2);
    row.p95Imbalance = num(p95Imbalance, 2);
    row.numIntents = numIntents;
    row.numIntentsPerDay = num(numIntents / intervalDays, 0);
  }

  return {
    peakReqCapArr: Object.values(resultObj).sort((a,b) => b.pnl - a.pnl)
  };
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
      MAX(expected_pnl_quote) AS max_pnl_quote,
      SUM(expected_pnl_quote) AS sum_pnl_quote,
      AVG(expected_pnl_bps) AS avg_pnl_bps,
      AVG(buy_quote) AS avg_buy_quote,
      MAX(buy_quote) AS max_buy_quote,
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

  const rawIntentsQ = `
  SELECT
    ts,
    symbol,
    buy_ex,
    sell_ex,
    expected_pnl_quote,
    buy_quote,
    sell_quote
  FROM trade_intent
  WHERE ts >= now() - interval '${PERIOD}'
  ORDER BY ts ASC;
`;

  const totalPnl = `
  SELECT SUM(expected_pnl_quote) AS total_pnl
  FROM trade_intent
  WHERE ts >= now() - interval '${PERIOD}';
  `;

  const [routesRes, recentRes, rawIntentsQRes, totalPnlRes] = await Promise.all([
    db.query(routesQ),
    db.query(recentQ),
    db.query(rawIntentsQ),
    db.query(totalPnl),
  ]);

  console.log('\n=== Top Routes by PnL ===');
  console.table(routesRes.rows.map((row) => ({
    symbol: row.symbol,
    buy_ex: row.buy_ex,
    sell_ex: row.sell_ex,
    intents: row.intents,
    sum_pnl_quote: num(row.sum_pnl_quote, 2),
    avg_pnl_quote: num(row.avg_pnl_quote, 2),
    max_pnl_quote: num(row.max_pnl_quote, 2),
    avg_pnl_bps: num(row.avg_pnl_bps, 4),
    avg_buy_quote: num(row.avg_buy_quote, 2),
    avg_target_qty: num(row.avg_target_qty, 6),
    last_seen: row.last_seen,
  })));

  const capitalStats = analyzeRequiredCapital(rawIntentsQRes.rows);

  console.log('\n=== Top symbols by capital efficiency & peak required capital ===');
  console.table(capitalStats.peakReqCapArr.slice(0, 15));
  
  console.log('\n=== Total PnL ===');
  console.log(`${num(totalPnlRes.rows[0].total_pnl, 2)} USD`);

  await db.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
