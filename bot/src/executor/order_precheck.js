'use strict';

/**
 * bringt beliebige zahl in von der boerse vorgegebenes "zahlenraster". verlustfrei und schnell
 * 
 * @param {Number} value - e.g. 1.2345
 * @param {Object} meta - {decimals: 2, factor: 100, stepInt:5}
 * @returns {{
 *   q    : Number, // e.g. 1.20
 *   qStr : String, // e.g. '1.20'
 * }}
 */
function floorByMeta(value, meta) {
  const { factor, stepInt, decimals } = meta;
  const vInt = Math.floor(Number(value) * factor);   // floor(1.2345 * 100) = 123
  const qInt = Math.floor(vInt / stepInt) * stepInt; // floor(123 / 5) * 5 = 24 * 5 = 120
  const q = qInt / factor;                           // 120 / 100 = 1.20
  return { q, qStr: q.toFixed(decimals) };
}

  // prepSymbolInfo: {
  //       "enabled": true,
  //       "base": "AXS",
  //       "quote": "USDC",
  //       "mdKey": "axsusdc",
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
function marketOrderPrecheckOk({
  side,                // "BUY" | "SELL"
  targetQty,           // quantity, e.g. 123 AXS to SELL or BUY
  q,                   // quote/notional in BASE, e.g. 123 AXS * 1 USDT/AXS = 100 USDT
  prepSymbolInfo,      // prepared (precompiled) symbolinfo: { enabled, minNotional, minQty, maxQty, qtyStep }
  exState,             // {enabled:true, balances:{ USDC: 100, AXS: 10 }}
  balance_minimum_usdt, // dieser bestand soll auf dem konto nie unterschritten werden
  // internal policy
  feeRate = 0,         // e.g. 0.001
}) {
  let ret = {ok:false, reason:null, fixedTargetQtyStr:''};

  //===========================================================================
  // check exchange requirements
  //===========================================================================
  if (!prepSymbolInfo.enabled) {
    ret.reason = 'EX_SYMBOL_DISABLED';
    return ret;
  }
  if (!exState.enabled) {
    ret.reason = 'EX_EXCHANGE_DISABLED';
    return ret;
  }
  const { q:fixedTargetQty, qStr: fixedTargetQtyStr } = floorByMeta(targetQty, prepSymbolInfo.rules.qty);
  if (q < prepSymbolInfo.rules.minNotional) {
    ret.reason = 'EX_MIN_NOTIONAL';
    return ret;
  }
  if (!fixedTargetQty || !prepSymbolInfo.rules.minQty ||
    fixedTargetQty < prepSymbolInfo.rules.minQty) {
    ret.reason = 'EX_MIN_QTY';
    return ret;
  }
  if (!fixedTargetQty || !prepSymbolInfo.rules.maxQty ||
    fixedTargetQty > prepSymbolInfo.rules.maxQty) {
    ret.reason = 'EX_MAX_QTY';
    return ret;
  }

  //===========================================================================
  // check our own requirements
  //===========================================================================
  const exBalanceUSDT = exState.balances[prepSymbolInfo.quote];
  const exBalanceBase = exState.balances[prepSymbolInfo.base];

  if (side === 'BUY') {
    const qInclFees = q * (1 + feeRate);
    const balanceAfterOrder = exBalanceUSDT - qInclFees;
    if (balanceAfterOrder < balance_minimum_usdt) {
      ret.reason = 'INT_INSUFFICIENT_BALANCE_USDT';
      return ret;
    }
  } else if (side === 'SELL') {
    if (exBalanceBase - fixedTargetQty < 0) {
      ret.reason = 'INT_INSUFFICIENT_BALANCE_BASE';
      return ret;
    }
  } 
  ret.ok = true;
  ret.fixedTargetQtyStr = fixedTargetQtyStr;
  return ret;
}

module.exports = { marketOrderPrecheckOk };
