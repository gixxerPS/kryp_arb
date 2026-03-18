const fs = require("node:fs");
const path = require("node:path");

const { asInt, precisionToStep } = require("./normalize");
const { mergeAndWriteOutput } = require('./output');

const BASE_URL = "https://api.mexc.com";
const FETCH_URL = `${BASE_URL}/api/v3/exchangeInfo`;

function internalToMexcSymbol(sym) {
  const [base, quote] = String(sym).trim().toUpperCase().split("_");
  return `${base}${quote}`;
  // return `${base}${quote === "USDT" ? "USDC" : quote}`;
}

async function fetchMexcSymbol(symbol) {
  const url = `${FETCH_URL}?symbol=${symbol}`;
  const res = await fetch(url);

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`MEXC fetch failed for ${symbol}: ${res.status} ${t}`);
  }

  const json = await res.json();
  return json.symbols?.[0] ?? null;
}

async function run({ SYMBOLINFO_DIR, wantedInternal }) {
  const OUT_PATH = path.join(SYMBOLINFO_DIR, "mexc.spot.json");
  const wanted = new Set(Array.from(wantedInternal).map(internalToMexcSymbol));

  const out = {
    meta: {
      source: FETCH_URL,
      fetchedAt: new Date().toISOString(),
    },
    symbols: {},
  };

  for (const symbol of wanted) {
    try {
      const s = await fetchMexcSymbol(symbol);
      if (!s) continue;

      const isEnabled = s.status === "1" && s.isSpotTradingAllowed === true;
      if (!isEnabled) continue;

      const pricePrecision = asInt(s.quotePrecision ?? s.quoteAssetPrecision);

      out.symbols[s.symbol] = {
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        status: s.status,
        enabled: true,
        pricePrecision,
        qtyPrecision: asInt(s.baseAssetPrecision),
        priceTick: precisionToStep(pricePrecision),
        priceTickDerivedFromPrecision: true,
        qtyStep: s.baseSizePrecision && s.baseSizePrecision !== "0" ? s.baseSizePrecision : null,
        minQty: null,
        maxQty: null,
        minNotional: null,
      };
    } catch (err) {
      console.log(`[mexc] error for ${symbol}: ${String(err?.message ?? err)}`);
    }
  }

  const mergedOut = mergeAndWriteOutput(OUT_PATH, out);
  console.log(`[mexc] wrote ${Object.keys(mergedOut.symbols).length} symbols to ${OUT_PATH}`);

  const missing = Array.from(wanted).filter((sym) => !mergedOut.symbols[sym]);
  if (missing.length) {
    console.error(
      `[mexc] missing (not TRADING or filtered): ` +
        missing.slice(0, 50).join(",") +
        (missing.length > 50 ? ` ... (+${missing.length - 50} more)` : "")
    );
  }
}

module.exports = { run };
