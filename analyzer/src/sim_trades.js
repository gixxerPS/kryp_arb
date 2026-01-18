/**
 * sim_trades.js
 *
 * Zweck:
 * ------
 * Simulation von Cross-Exchange Spot-Arbitrage auf Basis historischer
 * Best-Bid / Best-Ask (BBO) Daten aus PostgreSQL.
 *
 * Das Skript:
 * - joint Kursdaten mehrerer Börsen über Zeit-Bins
 * - berechnet Roh- und Netto-Spreads (inkl. Fees & Slippage)
 * - wendet Ausführungsrestriktionen (Cooldown) an
 * - aggregiert PnL je (Symbol × Route), je Symbol sowie insgesamt
 *
 * Annahmen:
 * ---------
 * - Taker-Ausführung auf beiden Legs (Spot)
 * - Feste Trade-Größe in USDT
 * - Kein Inventory-Rebalancing
 * - Keine Modellierung der Orderbuch-Tiefe
 *
 * Zentrale Parameter:
 * -------------------
 * PERIOD     : Betrachtungszeitraum der historischen Daten (z. B. '24 hours')
 * Q          : Trade-Größe pro Arbitrage-Leg (USDT)
 * MIN_RAW    : Mindest-Rohspread für einen Trade (Faktor, nicht Prozent)
 * SLIPPAGE   : Slippage-Puffer (Faktor, nicht Prozent)
 * COOLDOWN_S : Mindestabstand zwischen Trades pro (Symbol × Route) in Sekunden
 * fees_pct   : Maker-/Taker-Gebühren je Börse (aus config/exchanges.json)
 *
 * Ausgabe:
 * --------
 * - PnL je Symbol × Route (Top-N)
 * - Aggregierter PnL je Symbol
 * - Gesamt-PnL und Trade-Anzahl
 *
 * Hinweise:
 * ---------
 * Dieses Skript dient der Analyse und dem Screening von Arbitrage-
 * Opportunitäten. Die Ergebnisse sind optimistisch und stellen
 * eine obere Schranke gegenüber Live-Trading dar.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Client } = require('pg');
const { loadExchanges, feePctToFactor } = require('./exchanges');

const PERIOD = '24 hours';
const Q = 5000;           // USDT pro Trade
const SLIPPAGE = 0.0005;  // 0.05 %
const MIN_RAW = 0.003;    // 0.30 %
const MAX_ROWS_SYMBOL_ROUTE = 40; // max Zeilen für symbol x route Tabelle
const COOLDOWN_S = 36;    // nach abgesetztem trade diese route fuer x sek nicht nutzen

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
  const lastTradeAt = new Map(); // key: `${symbol}|${route}` -> bucket time (ms) of last trade
  const minGapMs = new Map(); // key -> min gap observed
  let skippedCooldown = 0;

  function cooldownKey(r) {
    return `${r.symbol}|${r.buy_ask}->${r.sell_bid}`;
  }
  for (const r of res.rows) {
    const raw = rawSpread(Number(r.buy_ask), Number(r.sell_bid));
    if (raw < MIN_RAW) continue;

    const buyFee = feePctToFactor(fees[r.buy_ex].taker_fee_pct);
    const sellFee = feePctToFactor(fees[r.sell_ex].taker_fee_pct);

    const net = raw - buyFee - sellFee - SLIPPAGE;
    if (net <= 0) continue;

    const k = cooldownKey(r);
    const tMs = new Date(r.t ?? r.ts).getTime(); // t = bin timestamp

    if (!Number.isFinite(tMs)) {
      log.error('invalid timestamp for cooldown', { t: r.t, ts: r.ts });
      continue;
    }

    const lastMs = lastTradeAt.get(k);

    // zeitabstand zum letzten trade
    if (lastMs != null) {
      const gap = tMs - lastMs;
      const prev = minGapMs.get(k);
      if (prev == null || gap < prev) minGapMs.set(k, gap);
    }

    // nur zaehlen wenn cooldown zeit abgelaufen ist
    if (lastMs != null && (tMs - lastMs) < COOLDOWN_S * 1000) {
      skippedCooldown += 1;
      continue;
    }

    const m = stats.get(r.symbol);
    const s = m.get(pairKey(r.buy_ex, r.sell_ex));

    s.trades += 1;
    s.pnl += Q * net;
    lastTradeAt.set(k, tMs);
  }

  // 3) Ausgabe
  //
  const feeSummary = {};

  for (const [ex, cfg] of Object.entries(fees)) {
    feeSummary[ex] = {
      taker_fee_pct: cfg.taker_fee_pct,
      maker_fee_pct: cfg.maker_fee_pct,
    };
  }

  console.log('\n=== Simulation Parameters ===');
  console.log({
    period: PERIOD,
    trade_size_usdt: Q,
    min_raw_spread_pct: (MIN_RAW * 100).toFixed(2),
    slippage_pct: (SLIPPAGE * 100).toFixed(2),
    fees_pct: feeSummary,
    cooldown_s: COOLDOWN_S
  });

  console.log('\n=== Cooldown Stats ===');
  console.log({
    cooldown_s: COOLDOWN_S,
    skipped_due_to_cooldown: skippedCooldown,
  });

  //console.log('\n=== Min Gap (ms) by route (top 20 smallest) ===');
  //console.log({ lastTradeAt_size: lastTradeAt.size });
  //const gaps = [];
  //for (const [k, v] of minGapMs.entries()) {
  //  gaps.push({ route: k, min_gap_ms: v });
  //}
  //gaps.sort((a, b) => a.min_gap_ms - b.min_gap_ms);
  //console.table(gaps.slice(0, 20));

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
  console.table(rows.slice(0, MAX_ROWS_SYMBOL_ROUTE));

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

  // Gesamtgewinn ausgeben
  // === PnL Total ===
  let totalTrades = 0;
  let totalPnl = 0;

  for (const r of rows) {
    totalTrades += r.trades;
    totalPnl += r.pnl_usdt;
  }

  console.log('\n==============================================================');
  console.log('=== PnL Total ===');
  console.log({
    trades: totalTrades,
    pnl_usdt: Number(totalPnl.toFixed(2)),
    avg_usdt_per_trade: totalTrades > 0
      ? Number((totalPnl / totalTrades).toFixed(4))
      : 0,
  });
  console.log('==============================================================');


  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

