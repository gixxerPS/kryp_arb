// Prefilter coins by CoinGecko market-cap rank and 24h volume/market-cap ratio.
//
// usage:
//   node index.js
//
// optional:
//   export COINGECKO_API_KEY=... node index.js
//
// Columns:
// - vol_mcap_ratio: 24h volume / market cap.
// - l2_min_ratio_pm/l2_max_ratio_pm: min/max 2% orderbook depth across top
//   volume markets, divided by market cap, in per mille.
// - l2_up_*_m/l2_dn_*_m: min/max USD needed to move price +2%/-2%
//   across top volume markets, in millions.
// - mcap_usd_m/vol_24h_usd_m: market cap and 24h volume in millions USD.

const fs = require('fs');
const path = require('path');

const CG_API_KEY = process.env.COINGECKO_API_KEY || '';
const CG_BASE = 'https://api.coingecko.com/api/v3';

const RANK_START = 100;
const RANK_END = 200;
const TOP_N = 25;

const CG_PER_PAGE = 250;
const OUT_DIR = path.join(__dirname, 'out');
const INCLUDE_DEPTH = true;
const DEPTH_REQUEST_DELAY_MS = 2200;
const DEPTH_TOP_MARKETS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundNumber(value, digits) {
  if (!Number.isFinite(value)) return '';
  return Number(value.toFixed(digits));
}

function toMillions(value) {
  return roundNumber(value / 1_000_000, 2);
}

function toDepthMillions(value) {
  return roundNumber(value / 1_000_000, 1);
}

function isUsdLikeSymbol(symbol) {
  return String(symbol || '').toUpperCase().includes('USD');
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

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-');
}

function writeCsvSnapshot(rows) {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const snapshotAt = new Date().toISOString();
  const csvRows = rows.map((row) => ({
    snapshot_at: snapshotAt,
    ...row,
  }));

  const fileName = `prefilter_rank_${RANK_START}_${RANK_END}_${timestampForFile()}.csv`;
  const filePath = path.join(OUT_DIR, fileName);
  fs.writeFileSync(filePath, toCsv(csvRows), 'utf8');

  return filePath;
}

async function fetchJson(url, params = {}) {
  const u = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    u.searchParams.set(key, String(value));
  }

  const headers = { accept: 'application/json' };
  if (CG_API_KEY) {
    headers['x-cg-demo-api-key'] = CG_API_KEY;
  }

  const response = await fetch(u, { method: 'GET', headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `HTTP ${response.status} for ${u.toString()} body=${body.slice(0, 300)}`
    );
  }

  return response.json();
}

async function fetchCoinGeckoMarketsPage(page) {
  const data = await fetchJson(`${CG_BASE}/coins/markets`, {
    vs_currency: 'usd',
    order: 'market_cap_desc',
    per_page: CG_PER_PAGE,
    page,
    sparkline: false,
    price_change_percentage: '24h',
  });

  if (!Array.isArray(data)) {
    throw new Error(`Unexpected CoinGecko response on page ${page}`);
  }

  return data;
}

async function fetchCoinGeckoMarkets() {
  const startPage = Math.floor((RANK_START - 1) / CG_PER_PAGE) + 1;
  const endPage = Math.ceil(RANK_END / CG_PER_PAGE);
  const all = [];

  for (let page = startPage; page <= endPage; page++) {
    const data = await fetchCoinGeckoMarketsPage(page);
    all.push(...data);
    if (page < endPage) await sleep(1200);
  }

  return all;
}

async function fetchCoinGeckoTickers(coinId) {
  const data = await fetchJson(`${CG_BASE}/coins/${coinId}/tickers`, {
    order: 'volume_desc',
    page: 1,
    depth: true,
  });

  if (!data || !Array.isArray(data.tickers)) {
    throw new Error(`Unexpected CoinGecko tickers response for ${coinId}`);
  }

  return data.tickers;
}

function getTickerVolumeUsd(ticker) {
  return toFiniteNumber(ticker.converted_volume?.usd);
}

function getDepth(ticker) {
  return {
    up: toFiniteNumber(ticker.cost_to_move_up_usd, NaN),
    down: toFiniteNumber(ticker.cost_to_move_down_usd, NaN),
  };
}

function hasDepth(ticker) {
  const { up, down } = getDepth(ticker);
  return Number.isFinite(up) && Number.isFinite(down) && up > 0 && down > 0;
}

function marketLabel(ticker) {
  return [
    ticker.market?.identifier,
    ticker.base,
    ticker.target,
  ]
    .filter(Boolean)
    .join(':');
}

function pickTopDepthMarkets(tickers, limit) {
  const byExchange = new Map();

  for (const ticker of tickers) {
    if (!hasDepth(ticker)) continue;

    const exchangeId = ticker.market?.identifier || marketLabel(ticker);
    const volumeUsd = getTickerVolumeUsd(ticker);
    const previous = byExchange.get(exchangeId);

    if (!previous || volumeUsd > previous.volumeUsd) {
      byExchange.set(exchangeId, { ticker, volumeUsd });
    }
  }

  return [...byExchange.values()]
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, limit)
    .map(({ ticker }) => ticker);
}

function aggregateDepth(tickers, marketCapUsd) {
  if (!tickers.length) return null;

  const upDepths = [];
  const downDepths = [];

  for (const ticker of tickers) {
    const { up, down } = getDepth(ticker);
    upDepths.push(up);
    downDepths.push(down);
  }

  const allDepths = [...upDepths, ...downDepths];
  const minDepth = Math.min(...allDepths);
  const maxDepth = Math.max(...allDepths);

  return {
    upMin: Math.min(...upDepths),
    upMax: Math.max(...upDepths),
    downMin: Math.min(...downDepths),
    downMax: Math.max(...downDepths),
    minPm: (minDepth / marketCapUsd) * 1000,
    maxPm: (maxDepth / marketCapUsd) * 1000,
  };
}

function printColumnLegend() {
  console.log('\n=== Column legend ===');
  console.log('vol_mcap_ratio     24h volume / market cap');
  console.log('l2_min_ratio_pm    smallest 2% depth across top volume markets / market cap, per mille');
  console.log('l2_max_ratio_pm    largest 2% depth across top volume markets / market cap, per mille');
  console.log('rank               CoinGecko market-cap rank');
  console.log('mcap_usd_m         market cap in millions USD');
  console.log('vol_24h_usd_m      24h volume in millions USD');
  console.log('cur_px_usd         current price in USD');
  console.log('px_chg_24h_pct     24h price change in percent');
  console.log('l2_up_*_m          min/max USD needed to move price +2%, in millions');
  console.log('l2_dn_*_m          min/max USD needed to move price -2%, in millions');
}

async function enrichRowsWithDepth(rows) {
  if (!INCLUDE_DEPTH) return rows;

  console.log(`\nLoading CoinGecko 2% depth for ${rows.length} prefiltered coins...`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    try {
      const tickers = await fetchCoinGeckoTickers(row.coingecko_id);
      const topMarkets = pickTopDepthMarkets(tickers, DEPTH_TOP_MARKETS);
      const depth = aggregateDepth(topMarkets, row._market_cap_usd);

      if (depth) {
        row.l2_min_ratio_pm = roundNumber(depth.minPm, 3);
        row.l2_max_ratio_pm = roundNumber(depth.maxPm, 3);
        row.l2_up_min_m = toDepthMillions(depth.upMin);
        row.l2_up_max_m = toDepthMillions(depth.upMax);
        row.l2_dn_min_m = toDepthMillions(depth.downMin);
        row.l2_dn_max_m = toDepthMillions(depth.downMax);
      } else {
        row.l2_min_ratio_pm = '';
        row.l2_max_ratio_pm = '';
        row.l2_up_min_m = '';
        row.l2_up_max_m = '';
        row.l2_dn_min_m = '';
        row.l2_dn_max_m = '';
      }
    } catch (err) {
      row.l2_min_ratio_pm = '';
      row.l2_max_ratio_pm = '';
      row.l2_up_min_m = '';
      row.l2_up_max_m = '';
      row.l2_dn_min_m = '';
      row.l2_dn_max_m = '';
      console.warn(`Depth failed for ${row.coingecko_id}: ${err.message}`);
    }

    if ((i + 1) % 10 === 0 || i + 1 === rows.length) {
      console.log(`Depth loaded: ${i + 1}/${rows.length}`);
    }

    if (i + 1 < rows.length) {
      await sleep(DEPTH_REQUEST_DELAY_MS);
    }
  }

  return rows;
}

function buildRows(cgMarkets) {
  const rows = [];

  for (const coin of cgMarkets) {
    const rank = toFiniteNumber(coin.market_cap_rank, NaN);
    if (!Number.isFinite(rank)) continue;
    if (rank < RANK_START || rank > RANK_END) continue;
    if (isUsdLikeSymbol(coin.symbol)) continue;

    const marketCap = toFiniteNumber(coin.market_cap);
    const volume24h = toFiniteNumber(coin.total_volume);
    if (marketCap <= 0 || volume24h < 0) continue;

    const ratio = volume24h / marketCap;

    const row = {
      symbol: String(coin.symbol || '').toUpperCase(),
      coingecko_id: coin.id,
      name: coin.name,
      vol_mcap_ratio: roundNumber(ratio, 6),
      l2_min_ratio_pm: '',
      l2_max_ratio_pm: '',
      rank,
      mcap_usd_m: toMillions(marketCap),
      vol_24h_usd_m: toMillions(volume24h),
      cur_px_usd: roundNumber(toFiniteNumber(coin.current_price, NaN), 4),
      px_chg_24h_pct: roundNumber(
        toFiniteNumber(coin.price_change_percentage_24h, NaN),
        1
      ),
      l2_up_min_m: '',
      l2_up_max_m: '',
      l2_dn_min_m: '',
      l2_dn_max_m: '',
    };

    Object.defineProperty(row, '_market_cap_usd', {
      value: marketCap,
      enumerable: false,
    });

    rows.push(row);
  }

  rows.sort((a, b) => {
    if (b.vol_mcap_ratio !== a.vol_mcap_ratio) {
      return b.vol_mcap_ratio - a.vol_mcap_ratio;
    }
    return a.rank - b.rank;
  });

  return rows;
}

async function main() {
  console.log('=== Params ===');
  console.log({
    rank_start: RANK_START,
    rank_end: RANK_END,
    top_n: TOP_N,
    depth_top_markets: INCLUDE_DEPTH ? DEPTH_TOP_MARKETS : 0,
    source: `${CG_BASE}/coins/markets`,
  });

  console.log('\nLoading CoinGecko market data...');
  const cgMarkets = await fetchCoinGeckoMarkets();
  console.log(`CoinGecko rows loaded: ${cgMarkets.length}`);

  const rows = buildRows(cgMarkets);
  console.log(`Matched rows in market cap rank ${RANK_START}-${RANK_END}: ${rows.length}`);

  const previewRows = rows.slice(0, TOP_N);
  await enrichRowsWithDepth(previewRows);

  console.log('\n=== Candidates (sorted by 24h volume / market cap) ===');
  console.table(previewRows);
  printColumnLegend();

  const csvPath = writeCsvSnapshot(rows);
  console.log(`\nCSV written: ${csvPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
