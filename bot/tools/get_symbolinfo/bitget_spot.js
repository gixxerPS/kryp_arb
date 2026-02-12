const fs = require("node:fs");
const path = require("node:path");

const { pow10Tick, asInt, asNumber, precisionToStep } = require("./normalize");

const BASE_URL = "https://api.bitget.com";
const FETCH_URL = `${BASE_URL}/api/v2/spot/public/symbols`;

function internalToBitget(s) {
    return String(s).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

async function fetchPairs() {
  const res = await fetch(FETCH_URL);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Bitget fetch failed: ${res.status} ${t}`);
  }
  const json = await res.json();
  return json.data;
}

async function fetchBitgetSymbol(symbol) {
    const url = `${FETCH_URL}?symbol=${symbol}`;
    const res = await fetch(url);
  
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Bitget fetch failed for ${symbol}: ${res.status} ${t}`);
    }
  
    const json = await res.json();
    if (json.code !== "00000") {
      throw new Error(`Bitget API error for ${symbol}: ${JSON.stringify(json)}`);
    }
  
    return json.data?.[0] ?? null;
  }

async function run({ BOT_CFG_PATH, SYMBOLINFO_DIR, wantedInternal }) {
  const OUT_PATH = path.join(SYMBOLINFO_DIR, "bitget.spot.json");

  const wanted = new Set(Array.from(wantedInternal).map(internalToBitget));
  console.log("[bitget] fetching only wanted symbols…");

  const out = {
    meta: {
      source: FETCH_URL,
      fetchedAt: new Date().toISOString(),
    },
    symbols: {},
  };

  for (const symbol of wanted) {

    try {
      const s = await fetchBitgetSymbol(symbol);
      // console.log(s);
      if (!s) continue;

      if (s.status !== "online") continue;

      const pricePrec = asInt(s.pricePrecision);
      const qtyPrec = asInt(s.quantityPrecision);

      out.symbols[s.symbol] = {
        symbol: s.symbol,
        baseAsset: s.baseCoin,
        quoteAsset: s.quoteCoin,
        status: s.status,
        enabled : s.status === 'online' ? true : false,

        pricePrecision: pricePrec,
        qtyPrecision: qtyPrec,

        priceTick: precisionToStep(pricePrec),
        priceTickDerivedFromPrecision:true, // selber berechnet nicht von boerse geliefert
        qtyStep: precisionToStep(qtyPrec),
        qtyStepDerivedFromPrecision:true, // selber berechnet nicht von boerse geliefert

        minQty: asNumber(s.minTradeAmount),
        maxQty: asNumber(s.maxTradeAmount ?? null),
        minNotional: asNumber(
          s.quoteCoin === "USDT" ? s.minTradeUSDT : null
        ),
      };

    } catch (err) {
        console.log(`[bitget] error for ${symbol}: ${String(err?.message ?? err)}`);
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`[bitget] wrote ${Object.keys(out.symbols).length} symbols to ${OUT_PATH}`);

  const missing = Array.from(wanted).filter((sym) => !out.symbols[sym]);
  if (missing.length) {
    console.error(
      `[bitget] missing (not TRADING or filtered): ` +
        missing.slice(0, 50).join(",") +
        (missing.length > 50 ? ` ... (+${missing.length - 50} more)` : "")
    );
  }
}

module.exports = { run };
