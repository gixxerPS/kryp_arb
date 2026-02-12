'use strict';

function decimalsFromTickStr(tickStr) {
  const s = String(tickStr);
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  const frac = s.slice(dot + 1).replace(/0+$/, "");
  return frac.length;
}

// TRUNC/FLOOR auf Tick, Ergebnis als string (für Qty besser)
function formatToTickFloor(value, tickStr) {
  const tick = Number(tickStr);
  const d = decimalsFromTickStr(tickStr);
  const q = Math.floor(Number(value) / tick) * tick;
  return q.toFixed(d);
}

function formatByPrecisionTrunc(value, precision) {
  const scale = 10 ** precision;
  const v = Math.trunc(Number(value) * scale) / scale;
  return v.toFixed(precision);
}

function parseSymbolInternal(symbol) {
  if (typeof symbol !== 'string') return {};
  const parts = symbol.split('_');
  if (parts.length !== 2) return {};
  return { base: parts[0], quote: parts[1] };
}


function marketOrderPrecheckOk({
  exchange,
  symbol,              // e.g. "AXS_USDC" (internal), muss zu state[exchange].balances[symbol] passen!
  side,                // "BUY" | "SELL"
  targetQty,           // quantity, e.g. 123 AXS to SELL or BUY
  q,                   // quote/notional in BASE, e.g. 123 AXS * 1 USDT/AXS = 100 USDT
  symbolInfo,          // normalized: { enabled, minNotional, minQty, maxQty, qtyStep }
  state,                // { binance: {enabled:true, balances:{ USDC: 100, AXS: 10 }}}
  balance_minimum_usdt, // dieser bestand soll auf dem konto nie unterschritten werden
  // internal policy
  feeRate = 0,         // e.g. 0.001
}) {
  let ret = {ok:false, reason:null, fixedTargetQtyStr:''};

  //===========================================================================
  // check exchange requirements
  //===========================================================================
  if (!symbolInfo.enabled) {
    ret.reason = 'EX_SYMBOL_DISABLED';
    return ret;
  }
  if (!state[exchange].enabled) {
    ret.reason = 'EX_EXCHANGE_DISABLED';
    return ret;
  }
  if (q < symbolInfo.minNotional) {
    ret.reason = 'EX_MIN_NOTIONAL';
    return ret;
  }
  let fixedTargetQtyStr;
  if (symbolInfo.qtyStepDerivedFromPrecision) {
    fixedTargetQtyStr = formatByPrecisionTrunc(targetQty, symbolInfo.qtyPrecision); // use 10^-qtyPrecision
  } else {
    fixedTargetQtyStr = formatToTickFloor(targetQty, symbolInfo.qtyStep); // use e.g. '0.05' qtyStep
  }
  const fixedTargetQty = Number(fixedTargetQtyStr);
  if (!fixedTargetQty || !symbolInfo.minQty ||
    fixedTargetQty < symbolInfo.minQty) {
    ret.reason = 'EX_MIN_QTY';
    return ret;
  }
  if (!fixedTargetQty || !symbolInfo.minQty ||
    fixedTargetQty > symbolInfo.maxQty) {
    ret.reason = 'EX_MAX_QTY';
    return ret;
  }

  //===========================================================================
  // check our own requirements
  //===========================================================================
  const { base, quote } = parseSymbolInternal(symbol);
  if (!base || !quote) {
    ret.reason = 'EX_BAD_SYMBOL';
    return ret;
  }
  const exBalanceUSDT = state[exchange].balances[quote];
  const exBalanceBase = state[exchange].balances[base];

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
