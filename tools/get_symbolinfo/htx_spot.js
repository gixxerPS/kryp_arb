const path = require("node:path");

const { asInt, asNumber, precisionToStep } = require("./normalize");
const { mergeAndWriteOutput } = require("./output");

const BASE_URL = "https://api.huobi.pro";
const SYMBOLS_URL = `${BASE_URL}/v2/settings/common/symbols`;
const MARKET_SYMBOLS_URL = `${BASE_URL}/v1/settings/common/market-symbols`;

function internalToHtxSymbol(sym) {
  return String(sym).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTX fetch failed for ${url}: ${res.status} ${t}`);
  }
  return res.json();
}

async function fetchHtxSymbol(symbol) {
  const [symbolsV2, marketSymbolsV1] = await Promise.all([
    fetchJson(`${SYMBOLS_URL}?symbols=${encodeURIComponent(symbol)}`),
    fetchJson(`${MARKET_SYMBOLS_URL}?symbols=${encodeURIComponent(symbol)}`),
  ]);

  const baseRow = Array.isArray(symbolsV2?.data) ? symbolsV2.data[0] ?? null : null;
  const marketRow = Array.isArray(marketSymbolsV1?.data) ? marketSymbolsV1.data[0] ?? null : null;
  return { baseRow, marketRow };
}

async function run({ SYMBOLINFO_DIR, wantedInternal }) {
  const OUT_PATH = path.join(SYMBOLINFO_DIR, "htx.spot.json");
  const wanted = new Set(Array.from(wantedInternal).map(internalToHtxSymbol));

  const out = {
    meta: {
      source: {
        symbols: SYMBOLS_URL,
        marketSymbols: MARKET_SYMBOLS_URL,
      },
      fetchedAt: new Date().toISOString(),
    },
    symbols: {},
  };

  for (const symbol of wanted) {
    try {
      const { baseRow, marketRow } = await fetchHtxSymbol(symbol);
      const row = marketRow ?? baseRow;
      if (!row) continue;

      const status = row.state ?? null;
      const apiTrading = row.at ?? "enabled";
      const enabled = status === "online" && apiTrading !== "disabled";
      if (!enabled) continue;

      const pricePrecision = asInt(row.pp);
      const qtyPrecision = asInt(row.ap);

      out.symbols[String(row.symbol).toUpperCase()] = {
        symbol: String(row.symbol).toUpperCase(),
        baseAsset: String(row.bc ?? "").toUpperCase() || null,
        quoteAsset: String(row.qc ?? "").toUpperCase() || null,
        status,
        enabled,
        pricePrecision,
        qtyPrecision,
        priceTick: pricePrecision == null ? null : precisionToStep(pricePrecision),
        priceTickDerivedFromPrecision: true,
        qtyStep: qtyPrecision == null ? null : precisionToStep(qtyPrecision),
        qtyStepDerivedFromPrecision: true,
        minQty: asNumber(row.minoa),
        maxQty: asNumber(row.maxoa),
        minNotional: asNumber(row.minov),
      };
    } catch (err) {
      console.log(`[htx] error for ${symbol}: ${String(err?.message ?? err)}`);
    }
  }

  const mergedOut = mergeAndWriteOutput(OUT_PATH, out);
  console.log(`[htx] wrote ${Object.keys(mergedOut.symbols).length} symbols to ${OUT_PATH}`);

  const missing = Array.from(wanted).filter((sym) => !mergedOut.symbols[sym.toUpperCase()]);
  if (missing.length) {
    console.error(
      `[htx] missing (not TRADING or filtered): ` +
        missing.slice(0, 50).join(",") +
        (missing.length > 50 ? ` ... (+${missing.length - 50} more)` : "")
    );
  }
}

module.exports = { run };
