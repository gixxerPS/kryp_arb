import { floorByStepMeta } from '../common/symbolinfo';
import type { ExSymbolInfo } from '../types/symbolinfo';
import type { OrderSide } from '../types/common';
import type { TradeIntent } from '../types/strategy';

type PrecheckExchangeState = {
  enabled: boolean;
  balances: Record<string, number>;
};

export type MarketOrderPrecheckReason =
  | 'EX_SYMBOL_DISABLED'
  | 'EX_EXCHANGE_DISABLED'
  | 'EX_MIN_NOTIONAL'
  | 'EX_MIN_QTY'
  | 'EX_MAX_QTY'
  | 'INT_INSUFFICIENT_BALANCE_USDT'
  | 'INT_INSUFFICIENT_BALANCE_BASE';

export type MarketOrderPrecheckResult = {
  ok: boolean;
  reason: MarketOrderPrecheckReason | null;
  reasonDesc: string;                       // description
  fixedTargetQtyStr: string;
};

export type MarketOrderPrecheckParams = {
  side: OrderSide;
  targetQty: number;
  q: number;
  prepSymbolInfo: ExSymbolInfo;
  exState: PrecheckExchangeState;
  balance_minimum_usdt?: number;
};

export type FloorQuantityQToBalanceParams = {
  intent: Pick<TradeIntent, 'targetQty' | 'qBuy' | 'qSell' | 'buyPxEff' | 'sellPxEff'>;
  side: OrderSide;
  prepSymbolInfo: ExSymbolInfo;
  exState: PrecheckExchangeState;
  balance_minimum_usdt?: number;
};

export type FloorQuantityQToBalanceResult = {
  ok: boolean;
  reasonDesc: string;
  targetQty: number;
  targetQtyStr: string;
  q: number;
};

export function floorQuantityQToBalance({
  intent,
  side,
  prepSymbolInfo,
  exState,
  balance_minimum_usdt = 0,
}: FloorQuantityQToBalanceParams): FloorQuantityQToBalanceResult {
  const ret: FloorQuantityQToBalanceResult = {
    ok: false,
    reasonDesc: '',
    targetQty: 0,
    targetQtyStr: '',
    q: 0,
  };
  if (!prepSymbolInfo.rules) {
    ret.reasonDesc = 'missing rules';
    return ret;
  }
  const pxEff = side === 'BUY'
    ? Number(intent.buyPxEff ?? 0)
    : Number(intent.sellPxEff ?? 0);
  if (!Number.isFinite(pxEff) || pxEff <= 0) {
    ret.reasonDesc = `invalid pxEff=${pxEff}`;
    return ret;
  }

  const exBalanceQuote = exState.balances[prepSymbolInfo.quote] ?? 0;
  const exBalanceBase = exState.balances[prepSymbolInfo.base] ?? 0;
  const rawQtyCap = side === 'BUY'
    ? Math.max(0, (exBalanceQuote - balance_minimum_usdt) / pxEff)
    : Math.max(0, exBalanceBase);
  const cappedQty = Math.min(intent.targetQty, rawQtyCap);
  const { q: fixedTargetQty, qStr: fixedTargetQtyStr } = floorByStepMeta(cappedQty, prepSymbolInfo.rules.qty);
  const fixedQ = fixedTargetQty * pxEff;
  const minQty = prepSymbolInfo.rules.minQty == null ? 0 : Number(prepSymbolInfo.rules.minQty);
  const minNotional = Number(prepSymbolInfo.rules.minNotional ?? 0);

  ret.targetQty = fixedTargetQty;
  ret.targetQtyStr = fixedTargetQtyStr;
  ret.q = fixedQ;

  if (!fixedTargetQty) {
    ret.reasonDesc = `fixedTargetQty=${fixedTargetQty}`;
    return ret;
  }
  if (fixedTargetQty < minQty) {
    ret.reasonDesc = `fixedTargetQty=${fixedTargetQty}; minQty=${minQty}`;
    return ret;
  }
  if (fixedQ < minNotional) {
    ret.reasonDesc = `q=${fixedQ}; minNotional=${minNotional}`;
    return ret;
  }

  ret.ok = true;
  return ret;
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
export function marketOrderPrecheckOk({
  side, // "BUY" | "SELL"
  targetQty, // quantity, e.g. 123 AXS to SELL or BUY
  q, // quote/notional in BASE, e.g. 123 AXS * 1 USDT/AXS = 123 USDT
  prepSymbolInfo, // prepared (precompiled) symbolinfo: { enabled, minNotional, minQty, maxQty, qtyStep }
  exState, // {enabled:true, balances:{ USDC: 100, AXS: 10 }}
  balance_minimum_usdt = 0, // dieser bestand soll auf dem konto nie unterschritten werden
}: MarketOrderPrecheckParams): MarketOrderPrecheckResult {
  const ret: MarketOrderPrecheckResult = { ok: false, reason: null, reasonDesc: '', fixedTargetQtyStr: '' };

  //===========================================================================
  // check exchange requirements
  //===========================================================================
  if (!prepSymbolInfo.enabled) {
    ret.reason = 'EX_SYMBOL_DISABLED';
    return ret;
  }
  if (!prepSymbolInfo.rules) {
    ret.reason = 'EX_SYMBOL_DISABLED';
    return ret;
  }
  if (!exState.enabled) {
    ret.reason = 'EX_EXCHANGE_DISABLED';
    return ret;
  }

  const rules = prepSymbolInfo.rules;
  const minQty = rules.minQty == null ? 0 : Number(rules.minQty);
  const maxQty = rules.maxQty == null ? Number.POSITIVE_INFINITY : Number(rules.maxQty);
  const { q: fixedTargetQty, qStr: fixedTargetQtyStr } = floorByStepMeta(targetQty, rules.qty);

  if (q < rules.minNotional) {
    ret.reason = 'EX_MIN_NOTIONAL';
    ret.reasonDesc = `q=${q}; minNotional=${rules.minNotional}`;
    return ret;
  }
  if (!fixedTargetQty || fixedTargetQty < minQty) {
    ret.reason = 'EX_MIN_QTY';
    ret.reasonDesc = `fixedTargetQty=${fixedTargetQty}; minQty=${minQty}`;
    return ret;
  }
  if (!fixedTargetQty || fixedTargetQty > maxQty) {
    ret.reason = 'EX_MAX_QTY';
    ret.reasonDesc = `targetQty=${fixedTargetQty}; minQty=${maxQty}`;
    return ret;
  }

  //===========================================================================
  // check our own requirements
  //===========================================================================
  const exBalanceUSDT = exState.balances[prepSymbolInfo.quote] ?? 0;
  const exBalanceBase = exState.balances[prepSymbolInfo.base] ?? 0;
  const feeRate = prepSymbolInfo.taker_fee;

  if (side === 'BUY') {
    // const qInclFees = q * (1 + feeRate);
    const balanceAfterOrder = exBalanceUSDT - q; // fees entfernt die werden nicht mit usd bezahlt sondern in boersenwaehrung
    if (balanceAfterOrder < balance_minimum_usdt) {
      ret.reason = 'INT_INSUFFICIENT_BALANCE_USDT';
      ret.reasonDesc = `q=${q}; feeRate=${feeRate}; min=${balance_minimum_usdt}`;
      return ret;
    }
  } else if (side === 'SELL') {
    if (exBalanceBase - fixedTargetQty < 0) {
      ret.reason = 'INT_INSUFFICIENT_BALANCE_BASE';
      ret.reasonDesc = `balance=${exBalanceBase}; targetQty=${fixedTargetQtyStr}`;
      return ret;
    }
  }

  ret.ok = true;
  ret.fixedTargetQtyStr = fixedTargetQtyStr;
  return ret;
}
