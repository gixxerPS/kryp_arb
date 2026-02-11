/**
 * @file index.js
 * @brief Updates exchange-specific symbol metadata used by the trading engine.
 *
 * The symbolinfo tool retrieves trading rule metadata for each configured
 * symbol and exchange (as defined in config/bot.json) and stores it locally
 * in config/symbolinfo/.
 *
 * For every symbol on every exchange, relevant constraints are fetched,
 * such as:
 * - Price tick size (PRICE_FILTER / tickSize)
 * - Quantity step size (LOT_SIZE / stepSize)
 * - Minimum and maximum order quantity
 * - Minimum notional size (MIN_NOTIONAL / NOTIONAL)
 * - Precision settings
 *
 * These values are required by the execution layer to:
 * - Validate orders before submission
 * - Round prices and quantities correctly
 * - Ensure compliance with exchange-specific trading rules
 * 
 * format resultfile:
 * // config/symbolinfo/<exchange>.spot.json
 * {
 *   meta: { ... },
 *   symbols: {
 *     "<EX_SYMBOL>": {
 *       symbol: "<EX_SYMBOL>",
 *       baseAsset: "AXS",
 *       quoteAsset: "USDT",
 *       status: "TRADING",          // oder "online"/"tradable"
 *       priceTick: "0.0001",        // kleinster Preis-Schritt
 *       qtyStep:   "0.001",         // kleinster Mengen-Schritt
 *       minQty:    "0.01",
 *       maxQty:    "1000000",       // falls nicht verfügbar: null
 *       minNotional: "10",          // quote-Notional-Minimum (falls verfügbar)
 *       pricePrecision: 4,          // Dezimalstellen
 *       qtyPrecision: 3             // Dezimalstellen
 *     }
 *   }
 * }
 */

const fs = require("node:fs");

const { SYMBOLINFO_DIR, BOT_CFG_PATH, SYMBOLS_CFG_PATH } = require("./paths");
const { run: runBinance }   = require("./binance_spot");
const { run: runGate } = require("./gate_spot");
const { run: runBitget } = require("./bitget_spot");

function loadWantedSymbols(botPath) {
  const bot = JSON.parse(fs.readFileSync(botPath, "utf8"));

  if (!Array.isArray(bot.symbols)) {
    throw new Error("symbols.json: symbols must be array");
  }

  // interne Form beibehalten: "AXS_USDT"
  return new Set(
    bot.symbols.map(s => String(s).trim().toUpperCase())
  );
}

async function main() {
  console.log("[symbolinfo] bot.json     :", BOT_CFG_PATH);
  console.log("[symbolinfo] symbols.json     :", SYMBOLS_CFG_PATH);
  console.log("[symbolinfo] output dir  :", SYMBOLINFO_DIR);

  fs.mkdirSync(SYMBOLINFO_DIR, { recursive: true });

  const wantedInternal = loadWantedSymbols(SYMBOLS_CFG_PATH);

  const ctx = {
    BOT_CFG_PATH,
    SYMBOLINFO_DIR,
    wantedInternal
  };

  await runBinance(ctx);
  await runGate(ctx);
  await runBitget(ctx);

  console.log("[symbolinfo] done");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
