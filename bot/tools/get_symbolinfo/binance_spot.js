#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const { pow10Tick, asInt, asNumber } = require("./normalize");

const BASE_URL = 'https://api.binance.com';
const FETCH_URL = `${BASE_URL}/api/v3/exchangeInfo`;

/**
 * Normalize symbol to Binance spot format
 * and convert USDT → USDC (Binance Spot convention in deinem Setup)
 *
 * Unterstützt:
 * - "BTCUSDT"
 * - "BTC_USDT"
 * - "BTC/USDT"
 * - "btc-usdt"
 */
function normalizeSymbol(s) {
  if (!s) return null;

  const raw = String(s).trim().toUpperCase();
  if (!raw) return null;

  // 1) Split base / quote falls Separator vorhanden
  const m = raw.match(/^([A-Z0-9]+)[/_-]?([A-Z0-9]+)$/);
  if (!m) return null;

  let base = m[1];
  let quote = m[2];

  // 2) Mapping-Regel für Binance
  if (quote === "USDT") {
    quote = "USDC";
  }

  return base + quote;
}

function pickFilter(filters, type) {
  return (filters || []).find((f) => f.filterType === type) || null;
}

async function fetchExchangeInfo(wanted) {
  const query = `?symbols=${encodeURIComponent(JSON.stringify(Array.from(wanted)))}`;
  const res = await fetch(FETCH_URL + query);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`binance fetch failed: ${res.status} ${t}`);
  }
  return res.json();
}

async function run({ BOT_CFG_PATH, SYMBOLINFO_DIR, wantedInternal }) {
  const OUT_PATH = path.join(SYMBOLINFO_DIR, "binance.spot.json");

  // wantedInternal: ["AXS_USDT", ...] -> Binance: ["AXSUSDC", ...]
  const wanted = new Set(
    Array.from(wantedInternal).map((sym) => {
      const [base, quote] = String(sym).trim().toUpperCase().split("_");
      return base + (quote === "USDT" ? "USDC" : quote);
    })
  );

  const exchangeInfo = await fetchExchangeInfo(wanted); // full exchangeInfo
  // console.log(exchangeInfo); // debug

  const symbols = exchangeInfo.symbols || [];

  const out = {
    meta: {
      source: FETCH_URL,
      fetchedAt: new Date().toISOString(),
      timezone: exchangeInfo.timezone ?? null,
      symbolCountRequested: wanted.size,
    },
    symbols: {},
  };

  for (const s of symbols) {
    if (s.status !== "TRADING") continue;

    // optional: wenn du NUR USDC traden willst, lass das drin
    if (s.quoteAsset !== "USDC") continue;

    // membership check (Binance exchange symbol)
    if (!wanted.has(s.symbol)) continue;

    const priceFilter = pickFilter(s.filters, "PRICE_FILTER");
    const lotSize = pickFilter(s.filters, "LOT_SIZE");
    const minNotional = pickFilter(s.filters, "MIN_NOTIONAL");
    const notional = pickFilter(s.filters, "NOTIONAL");

    const mn = asNumber(notional?.minNotional ?? minNotional?.minNotional ?? null);

    out.symbols[s.symbol] = {
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      status: s.status,

      minQty: asNumber(lotSize?.minQty ?? null),
      maxQty: asNumber(lotSize?.maxQty ?? null),
      minNotional: mn,
    };
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");

  const missing = Array.from(wanted).filter((sym) => !out.symbols[sym]);

  console.log(`[binance] wrote ${Object.keys(out.symbols).length} symbols to ${OUT_PATH}`);
  if (missing.length) {
    console.error(
      `[binance] missing (not TRADING or filtered): ` +
        missing.slice(0, 50).join(",") +
        (missing.length > 50 ? ` ... (+${missing.length - 50} more)` : "")
    );
  }
}


module.exports = { run };