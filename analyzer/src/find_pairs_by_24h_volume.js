// analyzer/src/find_pairs_by_24h_volume.js
// Fetches 24h volumes for USDT spot pairs from Binance, Gate, Bitget,
// then prints intersection + per-exchange volumes to help you pick "mid-volume" pairs.
//
// Sources:
// - Binance 24hr ticker: GET /api/v3/ticker/24hr (quoteVolume) :contentReference[oaicite:0]{index=0}
// - Bitget tickers: GET /api/v2/spot/market/tickers (usdtVolume; blank symbol => all) :contentReference[oaicite:1]{index=1}
// - Gate spot tickers endpoint base URL commonly used: /api/v4/spot/tickers (quote_volume) :contentReference[oaicite:2]{index=2}

const MIN_VOL_USDT = 500_000;   // min 24h quote volume (USDT)
const MAX_VOL_USDT = 20_000_000; // max 24h quote volume (USDT)
const TOP_N = 20;              // how many rows to print
const ONLY_INTERSECTION = true; // true: only pairs present on all 3 exchanges

const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/24hr?type=MINI';
const BITGET_URL = 'https://api.bitget.com/api/v2/spot/market/tickers';
const GATE_URL = 'https://api.gateio.ws/api/v4/spot/tickers';

function isUsdtSymbol(sym) {
  return typeof sym === 'string' && sym.endsWith('USDT');
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

async function fetchJson(url) {
  const r = await fetch(url, {
    method: 'GET',
    headers: { 'accept': 'application/json' },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} for ${url} body=${txt.slice(0, 200)}`);
  }
  return r.json();
}

async function getBinanceVolumes() {
  const data = await fetchJson(BINANCE_URL);
  // Response: array of tickers (symbol, quoteVolume, ...)
  const m = new Map();
  for (const t of data) {
    const symbol = t.symbol;
    if (!isUsdtSymbol(symbol)) continue;
    const vol = toNum(t.quoteVolume);
    m.set(symbol, vol);
  }
  return m;
}

async function getBitgetVolumes() {
  const j = await fetchJson(BITGET_URL);
  // { code, msg, data: [ { symbol, usdtVolume, ... } ] }
  const arr = Array.isArray(j.data) ? j.data : [];
  const m = new Map();
  for (const t of arr) {
    const symbol = t.symbol;
    if (!isUsdtSymbol(symbol)) continue;
    // Prefer usdtVolume (explicitly provided)
    const vol = toNum(t.usdtVolume ?? t.quoteVolume);
    m.set(symbol, vol);
  }
  return m;
}

async function getGateVolumes() {
  const data = await fetchJson(GATE_URL);
  // Response: array of tickers; common fields include currency_pair, quote_volume
  const m = new Map();
  for (const t of data) {
    const cp = t.currency_pair;
    if (typeof cp !== 'string') continue;
    // Gate uses "BASE_QUOTE" e.g. "ETH_USDT"
    if (!cp.endsWith('_USDT')) continue;
    const symbol = cp.replace('_', ''); // "ETH_USDT" -> "ETHUSDT"
    const vol = toNum(t.quote_volume ?? t.quoteVolume);
    m.set(symbol, vol);
  }
  return m;
}

function intersectKeys(a, b) {
  const out = new Set();
  for (const k of a.keys()) {
    if (b.has(k)) out.add(k);
  }
  return out;
}

async function main() {
  console.log('=== Params ===');
  console.log({
    min_vol_usdt: MIN_VOL_USDT,
    max_vol_usdt: MAX_VOL_USDT,
    top_n: TOP_N,
    only_intersection: ONLY_INTERSECTION,
    sources: { binance: BINANCE_URL, gate: GATE_URL, bitget: BITGET_URL },
  });

  const [binance, gate, bitget] = await Promise.all([
    getBinanceVolumes(),
    getGateVolumes(),
    getBitgetVolumes(),
  ]);

  console.log('=== Counts (USDT pairs) ===');
  console.log({
    binance: binance.size,
    gate: gate.size,
    bitget: bitget.size,
  });

  let universe = new Set();
  if (ONLY_INTERSECTION) {
    const bg = intersectKeys(binance, gate);
    const all3 = new Set();
    for (const k of bg) {
      if (bitget.has(k)) all3.add(k);
    }
    universe = all3;
  } else {
    for (const k of binance.keys()) universe.add(k);
    for (const k of gate.keys()) universe.add(k);
    for (const k of bitget.keys()) universe.add(k);
  }

  const rows = [];

  for (const sym of universe) {
    const vb = binance.get(sym) ?? 0;
    const vg = gate.get(sym) ?? 0;
    const vbg = bitget.get(sym) ?? 0;

    // Filter: at least one exchange volume in range (or all if intersection)
    const vols = [vb, vg, vbg].filter((x) => x > 0);
    if (vols.length === 0) continue;

    // For intersection mode, use min volume across exchanges as "bottleneck liquidity"
    const minVol = Math.min(vb || Infinity, vg || Infinity, vbg || Infinity);
    const maxVol = Math.max(vb, vg, vbg);

    const metric = ONLY_INTERSECTION ? minVol : maxVol;

    if (metric < MIN_VOL_USDT || metric > MAX_VOL_USDT) continue;

    rows.push({
      symbol: sym,
      min_vol_usdt: Number(minVol.toFixed(0)),
      max_vol_usdt: Number(maxVol.toFixed(0)),
      binance_vol_usdt: Number(vb.toFixed(0)),
      gate_vol_usdt: Number(vg.toFixed(0)),
      bitget_vol_usdt: Number(vbg.toFixed(0)),
      // simple imbalance score: higher means more uneven liquidity (often correlates with inefficiency)
      imbalance: Number((maxVol / Math.max(minVol, 1)).toFixed(2)),
    });
  }

  rows.sort((a, b) => {
    // Prefer: within-range pairs with higher imbalance, then higher min volume
    if (b.imbalance !== a.imbalance) return b.imbalance - a.imbalance;
    return b.min_vol_usdt - a.min_vol_usdt;
  });

  console.log('\n=== Candidates (sorted) ===');
  console.table(rows.slice(0, TOP_N));

  // Optional: print just symbols for easy copy/paste into symbols.json
  console.log('\n=== symbols.json snippet ===');
  const syms = rows.slice(0, Math.min(TOP_N, 100)).map((r) => r.symbol);
  console.log(JSON.stringify({ symbols: syms }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

