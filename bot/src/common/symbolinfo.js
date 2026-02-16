// common/symbolinfo.js
'use strict';

const { getBinanceStreamSuffix } = require('../common/util');

let _idx = null; // { [symbol_canon]: { canon:{base,quote}, [ex]: {...} } }
let _reverseIdx = null; // { [ex]:{[stream_symbol_from_exchange]: { canon : ...} }}

// AXS_USDT -> axsusdt
function symToBinance(sym) {
  return String(sym).replace('_', '').toLowerCase();
}

// axsusdc -> axsusdc@depth10@100ms
function symToBinanceStreamSuffix(exSym, levels, updateMs) {
  return `${exSym}@depth${levels}@${updateMs}ms`;
}

// AXS_USDT -> AXSUSDT
function symToBitget(sym) {
  return String(sym).replace('_', '').toUpperCase();
}

// AXS_USDT -> axs_usdt
function symToGate(sym) {
  return String(sym).toUpperCase();
}

function parseCanon(sym) {
  const [base, quote] = String(sym).split('_');
  return { base, quote };
}

function mapQuote(quote, exCfg) {
  return exCfg?.quote_map?.[quote] ?? quote;
}

/**
 * berechnung von hilfsfaktoren fuer spaeter schnelle berechnung von
 * fixedTargetQty.
 * 
 * bsp. stepStr = '0.05'
 * => decimals = 2
 * => factor = 100
 * => stepInt = round(0.05*100) = 5
 * 
 * spaetere ergebnis rechnung:
 * qty  = 1.23 => vInt = floor(1.23*100) = 100
 * qInt = floor(123/5)*5 = 24*5 = 120
 * q    = 120/100 = 1.20
 * 
 * @param {String} stepStr - e.g. '0.05'
 * @param {Number} qtyPrecision - e.g. 8
 * @returns {{
 *   decimals : number, // e.g. 2
 *   factor   : number, // e.g. 100
 *   stepInt  : number  // e.g. 5
 * }}
 * 
 */
function compileStepMeta(stepStr, qtyPrecision) {
  // stepStr bevorzugen (z.B. "0.05" oder "0.01")
  if (stepStr != null && stepStr.length > 0) {
    const s = String(stepStr);
    const d = decimalsFromTickStr(s);
    const factor = 10 ** d;
    const stepInt = Math.round(Number(s) * factor); // 0.05*100=5
    return { decimals: d, factor, stepInt };
  }

  // fallback: aus precision ableiten (nur wenn kein step geliefert wird)
  // hier ist stepInt=1 und decimals=qtyPrecision robust (keine float-step nötig)
  if (Number.isInteger(qtyPrecision) && qtyPrecision >= 0) {
    const d = qtyPrecision;
    const factor = 10 ** d;
    return { decimals: d, factor, stepInt: 1 };
  }

  return { decimals: 0, factor: 1, stepInt: 0 };
}

function decimalsFromTickStr(tickStr) {
  const s = String(tickStr);
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  const frac = s.slice(dot + 1).replace(/0+$/, '');
  return frac.length;
}

function compileRules(raw) {
  if (!raw) return null;

  const enabled = raw?.enabled !== false;

  const qtyMeta = compileStepMeta(raw.qtyStep, raw.qtyPrecision);

  const qtyStep =
    Number(raw?.qtyStep) > 0 ? Number(raw.qtyStep)
    : (Number.isInteger(raw?.qtyPrecision) ? 10 ** (-raw.qtyPrecision) : 0);

  const priceTick =
    Number(raw?.priceTick) > 0 ? Number(raw.priceTick)
    : (Number.isInteger(raw?.pricePrecision) ? 10 ** (-raw.pricePrecision) : 0);

  return {
    enabled,
    qtyStep,
    qty:qtyMeta, // integer hilfsfelder um zur laufzeit schnell rechnen zu koennen
    priceTick,
    minQty: Number(raw?.minQty ?? 0),
    maxQty: Number(raw?.maxQty ?? 0),
    minNotional: Number(raw?.minNotional ?? 0),
  };
}

// orderKey: passend zu symbolinfo + order API
function makeOrderKey(ex, symMapped) {
  if (ex === 'binance' || ex === 'bitget') {
    return String(symMapped).replace('_', '').toUpperCase(); // AXSUSDC
  }
  if (ex === 'gate') {
    return String(symMapped);
  }
  return symMapped;
}

// mdKey: WS subscription keys (bestehende helpers)
function makeMdKey(ex, symMapped, subscription) {
  if (ex === 'binance') {
    return symToBinanceStreamSuffix(
      symToBinance(symMapped), 
      subscription.levels, 
      subscription.updateMs
    );
  }
  if (ex === 'bitget')  return symToBitget(symMapped);
  if (ex === 'gate')    return symToGate(symMapped);
}

function makeExtra(ex, symMapped, subscription) {
  if (ex === 'binance') return {};
  if (ex === 'bitget')  return { channel: `books${subscription.levels}`};
  if (ex === 'gate')    return {};
}

 
/**
 * @param {object} args
 * @param {string[]} args.symbolsCanon
 * @param {object} args.exchangesCfg
 * @param {object} args.symbolInfoByEx  - { binance:{meta, symbols:{}}, bitget:{...}, gate:{...} }
 * @param {object} [args.log]
 */

// idx: {
//   "AXS_USDT": {
//     "canon": {
//       "base": "AXS",
//       "quote": "USDT"
//     },
//     "binance": {
//       "enabled": true,
//       "base": "AXS",
//       "quote": "USDC",
//       "mdKey": "axsusdc@depth10@100ms",
//       "orderKey": "AXSUSDC",
//       "rules": {
//         "enabled": true,
//         "qtyStep": 0.01,
//         "priceTick": 0.001,
//         "minQty": 0.01,
//         "maxQty": 900000,
//         "minNotional": 5
//       }
//     },
//     "gate": {
//       "enabled": false,
//       "base": "AXS",
//       "quote": "USDT",
//       "mdKey": "axs_usdt",
//       "orderKey": "axs_usdt",
//       "rules": null
//     },
//     "bitget": {
//       "enabled": true,
//       "base": "AXS",
//       "quote": "USDT",
//       "mdKey": "AXSUSDT",
//       "orderKey": "AXSUSDT",
//       "rules": {
//         "enabled": true,
//         "qtyStep": 0.0001,
//         "priceTick": 0.001,
//         "minQty": 0,
//         "maxQty": 900000000000000000000,
//         "minNotional": 1
//       }, 
//       "extra": {
//         channel: 'books<Level>'
//       }
//     }
//   },

// _reverseIdx : {
//   binance:{
//     mdKey: { axsusdc@depth10@100ms:{ canon:'AXS_USDT' }},
//     orderKey: { AXSUSDC: { canon:'AXS_USDT'}}
//   },
//   bitget:{
//     mdKey: { AXSUSDT:{ canon:'AXS_USDT'} },
//     orderKey: { AXSUSDT:{ canon:'AXS_USDT'} },
//   },
//   gate:{
//     mdKey: { axs_usdt:{ canon: 'AXS_USDT' } },
//     orderKey: {  AXSUSDT:{ canon:'AXS_USDT'} },
//   }
// }
function init({ symbolsCanon, exchangesCfg, symbolInfoByEx, log }) {

  // build vorwaerts index (von canonical nach exchange symbol, z.b. AXS_USDT -> binance:AXS_USDC)
  // inkl exchange und symbolspezifische regeln fuer die order validierung
  const idx = {};
  const reverseIdx = {}; // build rueckwaerts index (von exchange symbol nach canonical, z.b. axsusdc@depth@100ms -> canon:AXS_USDT )

  for (const symCanon of symbolsCanon ?? []) {
    const canon = parseCanon(symCanon);
    idx[symCanon] = { canon };

    for (const [ex, exCfg] of Object.entries(exchangesCfg ?? {})) {
      if (exCfg?.enabled === false) continue;

      const siEx = symbolInfoByEx?.[ex];
      const symbolsMap = siEx?.symbols;
      if (!symbolsMap) continue;

      const quoteEx = mapQuote(canon.quote, exCfg);
      const symMapped = `${canon.base}_${quoteEx}`;

      const orderKey = makeOrderKey(ex, symMapped);
      const mdKey = makeMdKey(ex, symMapped, exCfg.subscription);
      const extra = makeExtra(ex, symMapped, exCfg.subscription); // exchange besonderheiten

      const rawSi = symbolsMap[orderKey] ?? null;
      const rules = compileRules(rawSi);

      const enabled = Boolean(rules?.enabled);

      if (!rawSi) log?.warn?.({ ex, symCanon, orderKey, mdKey }, 'symbolinfo missing for mapped symbol');
      if (!enabled) log?.warn?.({ ex, symCanon, orderKey }, 'symbol disabled/not trading');

      idx[symCanon][ex] = {
        enabled,
        base: canon.base,
        quote: quoteEx,
        mdKey,
        orderKey,
        rules,
        extra
        //raw: rawSi, // optional, später entfernen
      };

      reverseIdx[ex] ??= {};
      reverseIdx[ex].mdKey ??= {};
      reverseIdx[ex].orderKey ??= {};
      reverseIdx[ex].mdKey[mdKey] = { canon: symCanon };
      reverseIdx[ex].orderKey[orderKey] = { canon: symCanon };
    }
  }
  _idx = idx;
  _reverseIdx = reverseIdx;
}

function getIndex() {
  if (!_idx) throw new Error('symbolinfo not initialized; call symbolinfo.init(...) at startup');
  return _idx;
}

function getReverseIndex() {
  if (!_reverseIdx) throw new Error('symbolinfo not initialized; call symbolinfo.init(...) at startup');
  return _reverseIdx;
}

// request by canonical symbol, e.g. AXS_USDT even if exchange maps to AXS_USDC
function getSymbolInfo(symbolCanon) {
  return getIndex()[symbolCanon] ?? null;
}

function getEx(symbolCanon, ex) {
  const v = getSymbolInfo(symbolCanon);
  return v ? (v[ex] ?? null) : null;
}

// axsusdc@depth10@100ms -> AXS_USDT
function getCanonFromStreamSym(sym, ex) {
  const r = getReverseIndex()[ex];
  return r?.mdKey[sym]?.canon ?? null;
}

// z.B. binance: AXSUSDC -> AXS_USDT
function getCanonFromOderSym(sym, ex) {
  const r = getReverseIndex()[ex];
  return r?.orderKey[sym]?.canon ?? null;
}

function _resetForTests() { 
  _idx = null; 
  _reverseIdx = null;
}

module.exports = {
  init,
  getIndex,
  getSymbolInfo,
  getEx,
  // for tests
  compileRules,
  makeOrderKey,
  makeMdKey,
  getCanonFromStreamSym,
  getCanonFromOderSym,
  getReverseIndex,
  _resetForTests,
};