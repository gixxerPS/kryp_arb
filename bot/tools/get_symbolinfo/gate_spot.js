const fs = require("node:fs");
const path = require("node:path");

const { pow10Tick, asInt, asNumber } = require("./normalize");

const BASE_URL = 'https://api.gateio.ws';
const FETCH_URL = `${BASE_URL}/api/v4/spot/currency_pairs`;

function normalizeInternalSymbol(s) {
  return String(s).trim().toUpperCase();
}

// async function fetchPairs() {
//   const res = await fetch(FETCH_URL);
//   if (!res.ok) {
//     const t = await res.text().catch(() => "");
//     throw new Error(`Gate fetch failed: ${res.status} ${t}`);
//   }
//   return res.json();
// }

async function fetchGatePair(symbol) {
  const url = `${FETCH_URL}/${symbol}`;
  const res = await fetch(url);

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gate fetch failed for ${symbol}: ${res.status} ${t}`);
  }

  return res.json();
}

async function run({ BOT_CFG_PATH, SYMBOLINFO_DIR, wantedInternal }) {
  const OUT_PATH = path.join(SYMBOLINFO_DIR, "gate.spot.json");

  console.log("[gate] fetching pairs…");

  const out = {
    meta: {
      source: FETCH_URL,
      fetchedAt: new Date().toISOString(),
    },
    symbols: {},
  };

  for (const sym of wantedInternal) {
    const symbol = String(sym).trim().toUpperCase();

    try {
      const p = await fetchGatePair(symbol);
      // console.log(p); // debug

      if (p.trade_status !== "tradable") continue;

      const pricePrec = asInt(p.precision);
      const qtyPrec = asInt(p.amount_precision);

      out.symbols[p.id] = {
        symbol: p.id,
        baseAsset: p.base,
        quoteAsset: p.quote,
        status: p.trade_status,

        pricePrecision: pricePrec,
        qtyPrecision: qtyPrec,

        minQty: asNumber(p.min_base_amount),
        maxQty: asNumber(p.max_base_amount ?? null),
        minNotional: asNumber(p.min_quote_amount),
      };

    } catch (err) {
      console.log("[gate] missing or error:", symbol);
    }
  }
  

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`[gate] wrote ${Object.keys(out.symbols).length} symbols to ${OUT_PATH}`);
  
  const missing = Array.from(wantedInternal).filter((sym) => !out.symbols[sym]);
  if (missing.length) {
    console.error(
      `[gate] missing (not TRADING or filtered): ` +
        missing.slice(0, 50).join(",") +
        (missing.length > 50 ? ` ... (+${missing.length - 50} more)` : "")
    );
  }
}

module.exports = { run };
