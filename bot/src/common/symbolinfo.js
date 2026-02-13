// common/symbolinfo.js
'use strict';

let _idx = null; // { [symbol_canon]: { canon:{base,quote}, [ex]: {...} } }

// AXS_USDT -> axsusdt
function symToBinance(sym) {
    return String(sym).replace('_', '').toLowerCase();
  }
  
  // AXS_USDT -> AXSUSDT
  function symToBitget(sym) {
    return String(sym).replace('_', '').toUpperCase();
  }
  
  // AXS_USDT -> axs_usdt
  function symToGate(sym) {
    return String(sym).toLowerCase();
  }

function parseCanon(sym) {
  const [base, quote] = String(sym).split('_');
  return { base, quote };
}

function mapQuote(quote, exCfg) {
  return exCfg?.quote_map?.[quote] ?? quote;
}

function compileRules(raw) {
    if (!raw) return null;
  
    const enabled = raw?.enabled !== false;
  
    const qtyStep =
      Number(raw?.qtyStep) > 0 ? Number(raw.qtyStep)
      : (Number.isInteger(raw?.qtyPrecision) ? 10 ** (-raw.qtyPrecision) : 0);
  
    const priceTick =
      Number(raw?.priceTick) > 0 ? Number(raw.priceTick)
      : (Number.isInteger(raw?.pricePrecision) ? 10 ** (-raw.pricePrecision) : 0);
  
    return {
      enabled,
      qtyStep,
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
      return String(symMapped).toLowerCase(); // muss zu euren Gate-keys passen
    }
    return symMapped;
  }
  
  // mdKey: WS subscription keys (bestehende helpers)
  function makeMdKey(ex, symMapped) {
    if (ex === 'binance') return symToBinance(symMapped);
    if (ex === 'bitget')  return symToBitget(symMapped);
    if (ex === 'gate')    return symToGate(symMapped);
    return symMapped;
  }
  
  /**
   * @param {object} args
   * @param {string[]} args.symbolsCanon
   * @param {object} args.exchangesCfg
   * @param {object} args.symbolInfoByEx  - { binance:{meta, symbols:{}}, bitget:{...}, gate:{...} }
   * @param {object} [args.log]
   */
  function init({ symbolsCanon, exchangesCfg, symbolInfoByEx, log }) {
    if (_idx) return _idx;
  
    const idx = {};
  
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
        const mdKey = makeMdKey(ex, symMapped);
  
        const rawSi = symbolsMap[orderKey] ?? null;
        const rules = compileRules(rawSi);
  
        const enabled = Boolean(rules?.enabled);
  
        if (!rawSi) log?.warn?.({ ex, symCanon, orderKey, mdKey }, 'symbolinfo missing for mapped symbol');
        else if (!enabled) log?.warn?.({ ex, symCanon, orderKey }, 'symbol disabled/not trading');
  
        idx[symCanon][ex] = {
          enabled,
          base: canon.base,
          quote: quoteEx,
          mdKey,
          orderKey,
          rules,
          //raw: rawSi, // optional, später entfernen
        };
      }
    }
  
    _idx = idx;
    return _idx;
  }
  
  function getIndex() {
    if (!_idx) throw new Error('symbolinfo not initialized; call symbolinfo.init(...) at startup');
    return _idx;
  }
  
  function getSymbolInfo(symbolCanon) {
    return getIndex()[symbolCanon] ?? null;
  }
  
  function getEx(symbolCanon, ex) {
    const v = getSymbolInfo(symbolCanon);
    return v ? (v[ex] ?? null) : null;
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
  };