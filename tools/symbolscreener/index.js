// save as gate_volume_marketcap_ranker.js
// usage:
//   npm i axios
//   node gate_volume_marketcap_ranker.js
//
// optional:
//   COINGECKO_API_KEY=... node gate_volume_marketcap_ranker.js

const fs = require('fs');
const axios = require('axios');

const CG_API_KEY = process.env.COINGECKO_API_KEY || '';
const CG_BASE = 'https://api.coingecko.com/api/v3';
const GATE_BASE = 'https://api.gateio.ws/api/v4';

// Wie viele CoinGecko-Seiten laden?
// 250 pro Seite => 4 Seiten = Top 1000 nach Market Cap
const CG_PAGES = 4;
const CG_PER_PAGE = 250;

// Kleine manuelle Overrides für Symbole, falls CoinGecko-Symbol != Gate-Symbol
const SYMBOL_OVERRIDES = {
  // Beispiel:
  // 'XNO': 'NANO',
};

// Coins ausschließen, wenn du willst
const EXCLUDED_SYMBOLS = new Set([
  // 'USDT', 'USDC'
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return lines.join('\n');
}

async function fetchGateUsdtPairs() {
  const url = `${GATE_BASE}/spot/tickers`;
  const { data } = await axios.get(url, { timeout: 30000 });

  const pairs = new Set();
  for (const item of data) {
    const pair = item?.currency_pair;
    if (typeof pair === 'string' && pair.endsWith('_USDT')) {
      pairs.add(pair.toUpperCase());
    }
  }

  return pairs;
}

async function fetchCoinGeckoMarketsPage(page) {
  const headers = {};
  if (CG_API_KEY) {
    headers['x-cg-demo-api-key'] = CG_API_KEY;
  }

  const { data } = await axios.get(`${CG_BASE}/coins/markets`, {
    headers,
    timeout: 30000,
    params: {
      vs_currency: 'usd',
      order: 'market_cap_desc',
      per_page: CG_PER_PAGE,
      page,
      sparkline: false,
      price_change_percentage: '24h',
    },
  });

  if (!Array.isArray(data)) {
    throw new Error(`Unexpected CoinGecko response on page ${page}`);
  }

  return data;
}

async function fetchAllCoinGeckoMarkets() {
  const all = [];
  for (let page = 1; page <= CG_PAGES; page++) {
    const data = await fetchCoinGeckoMarketsPage(page);
    all.push(...data);

    // kleine Pause für Demo-Key / Rate-Limit-Freundlichkeit
    if (page < CG_PAGES) {
      await sleep(1200);
    }
  }
  return all;
}

function normalizeSymbol(symbol) {
  const upper = String(symbol || '').toUpperCase();
  return SYMBOL_OVERRIDES[upper] || upper;
}

function buildRows(gatePairs, cgMarkets) {
  const rows = [];

  for (const coin of cgMarkets) {
    const rawSymbol = String(coin.symbol || '').toUpperCase();
    const symbol = normalizeSymbol(rawSymbol);

    if (!symbol || EXCLUDED_SYMBOLS.has(symbol)) continue;
    if (!Number.isFinite(coin.market_cap_rank)) continue;
    if (coin.market_cap_rank <= 100) continue;
    if (!Number.isFinite(coin.market_cap) || coin.market_cap <= 0) continue;
    if (!Number.isFinite(coin.total_volume) || coin.total_volume < 0) continue;

    const gatePair = `${symbol}_USDT`;
    if (!gatePairs.has(gatePair)) continue;

    const ratio = coin.total_volume / coin.market_cap;

    rows.push({
      gate_pair: gatePair,
      symbol,
      coingecko_id: coin.id,
      name: coin.name,
      market_cap_rank: coin.market_cap_rank,
      market_cap_usd: Number(coin.market_cap.toFixed(2)),
      volume_24h_usd: Number(coin.total_volume.toFixed(2)),
      volume_marketcap_ratio: Number(ratio.toFixed(6)),
      current_price_usd: Number.isFinite(coin.current_price)
        ? Number(coin.current_price.toFixed(8))
        : '',
      price_change_24h_pct: Number.isFinite(coin.price_change_percentage_24h)
        ? Number(coin.price_change_percentage_24h.toFixed(4))
        : '',
    });
  }

  rows.sort((a, b) => {
    if (b.volume_marketcap_ratio !== a.volume_marketcap_ratio) {
      return b.volume_marketcap_ratio - a.volume_marketcap_ratio;
    }
    return a.market_cap_rank - b.market_cap_rank;
  });

  return rows;
}

async function main() {
  console.log('Loading Gate USDT pairs...');
  const gatePairs = await fetchGateUsdtPairs();
  console.log(`Gate USDT pairs: ${gatePairs.size}`);

  console.log('Loading CoinGecko market pages...');
  const cgMarkets = await fetchAllCoinGeckoMarkets();
  console.log(`CoinGecko rows loaded: ${cgMarkets.length}`);

  const rows = buildRows(gatePairs, cgMarkets);

  console.log(`Matched rows after filtering: ${rows.length}`);

  const preview = rows.slice(0, 30).map((r, i) => ({
    pos: i + 1,
    gate_pair: r.gate_pair,
    rank: r.market_cap_rank,
    ratio: r.volume_marketcap_ratio,
    volume_24h_usd: r.volume_24h_usd,
    market_cap_usd: r.market_cap_usd,
    name: r.name,
  }));

  console.table(preview);

  const csv = toCsv(rows);
  const outFile = 'gate_usdt_volume_marketcap_rank_gt100.csv';
  fs.writeFileSync(outFile, csv, 'utf8');

  console.log(`CSV written: ${outFile}`);
}

main().catch((err) => {
  const details = err.response?.data
    ? JSON.stringify(err.response.data, null, 2)
    : err.stack || err.message;
  console.error(details);
  process.exit(1);
});
