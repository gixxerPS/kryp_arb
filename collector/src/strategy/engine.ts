import { EXCHANGE_QUALITY } from '../common/constants';
import { getLogger } from '../common/logger';
import { getEx } from '../common/symbolinfo';

import type { AppConfig } from '../types/config';
import type { ExchangeId } from '../types/common';
import type { ComputeIntentsForSymArgs, L2Level, TradeIntentDraft } from '../types/strategy';

const log = getLogger('strategy');

type QWithinSlippageResult = {
  q: number;
  limLvlIdx: number;
  pxLim: number;
  targetQty: number;
};

type BestIntentSliceResult = {
  targetQty: number;
  qBuy: number;
  qSell: number;
  buyPxWorst: number;
  sellPxWorst: number;
  expectedPnl: number;
};

type EngineRuntime = {
  rawBuffer: number;
  slippage: number;
  qMin: number;
  qMax: number;
  overrides: {
    addRawSpreadBuffer: {
      byExchange: Partial<Record<ExchangeId, number>>;
      bySymbol: Record<string, number>;
    };
  };
};

let runtime: EngineRuntime | null = null;

export function initStrategyEngine(cfg: AppConfig): void {
  runtime = {
    rawBuffer: Number(cfg.bot.raw_spread_buffer_pct) * 0.01,
    slippage: Number(cfg.bot.slippage_pct) * 0.01,
    qMin: Number(cfg.bot.q_min_usdt),
    qMax: Number(cfg.bot.q_max_usdt),
    overrides: {
      addRawSpreadBuffer: {
        byExchange: Object.fromEntries(
          Object.entries(cfg.bot.overrides?.add_raw_spread_buffer_pct?.by_exchange ?? {}).map(([exchange, pct]) => [
            exchange,
            Number(pct) * 0.01,
          ])
        ) as Partial<Record<ExchangeId, number>>,
        bySymbol: Object.fromEntries(
          Object.entries(cfg.bot.overrides?.add_raw_spread_buffer_pct?.by_symbol ?? {}).map(([symbol, pct]) => [
            symbol,
            Number(pct) * 0.01,
          ])
        ),
      },
    },
  };
}

function rawSpread(buyAsk: number, sellBid: number): number {
  return (sellBid - buyAsk) / buyAsk;
}

function getAddRawSpreadBuffer(
  {
    sym,
    buyEx,
    sellEx,
    rt,
  }: {
    sym: string;
    buyEx: ExchangeId;
    sellEx: ExchangeId;
    rt: EngineRuntime;
  }
): number {
  const overrides = rt.overrides.addRawSpreadBuffer;
  return (overrides.bySymbol[sym] ?? 0)
    + (overrides.byExchange[buyEx] ?? 0)
    + (overrides.byExchange[sellEx] ?? 0);
}

export function bestBidPx(bids: L2Level[] | undefined | null): number {
  let best = -Infinity;
  for (const lvl of bids || []) {
    const px = Number(lvl?.[0]);
    if (Number.isFinite(px) && px > best) best = px;
  }
  return Number.isFinite(best) ? best : NaN;
}

export function bestAskPx(asks: L2Level[] | undefined | null): number {
  let best = Infinity;
  for (const lvl of asks || []) {
    const px = Number(lvl?.[0]);
    if (Number.isFinite(px) && px < best) best = px;
  }
  return Number.isFinite(best) ? best : NaN;
}

function getQWithinSlippage(
  { levels, slippage, qMax }: { levels: L2Level[]; slippage: number; qMax: number }
): QWithinSlippageResult {
  const l = levels.length;
  const bestPx = Number(levels[0][0]);
  const bestQty = Number(levels[0][1]);
  const bestLevelQ = bestPx * bestQty;
  let q = Math.min(qMax, bestLevelQ);
  let targetQty = bestLevelQ > qMax && bestPx > 0
    ? qMax / bestPx
    : bestQty;
  let dir = 1;

  if (l > 1) {
    dir = Number(levels[1][0]) > Number(levels[0][0]) ? 1 : -1;
  } else {
    if (bestPx === 0) return { q, limLvlIdx: 0, pxLim: 0, targetQty };
  }

  const pxLim = dir === 1 ? bestPx * (1 + slippage) : bestPx * (1 - slippage);

  let i = 1;
  for (; i < l; i += 1) {
    const px = Number(levels[i][0]);
    const qty = Number(levels[i][1]);
    if (px * dir > pxLim * dir) break;

    const qLevel = px * qty;
    const qRemaining = qMax - q;
    if (qRemaining <= 0) break;

    if (qLevel <= qRemaining) {
      q += qLevel;
      targetQty += qty;
    } else {
      if (px === 0) return { q, limLvlIdx: 0, pxLim: 0, targetQty };
      const partialQty = qRemaining / px;
      q += qRemaining;
      targetQty += partialQty;
      i += 1;
      break;
    }
  }

  q = Math.min(qMax, q);
  return { q, limLvlIdx: i - 1, pxLim, targetQty };
}

function getQFromQtyL2({ levels, targetQty }: { levels: L2Level[]; targetQty: number }): number {
  let q = 0;
  let qtyRemaining = targetQty;
  for (let i = 0; i < levels.length; i += 1) {
    const px = Number(levels[i][0]);
    const qty = Number(levels[i][1]);
    if (qtyRemaining <= qty) {
      q += px * qtyRemaining;
      break;
    }
    qtyRemaining -= qty;
    q += px * qty;
  }
  return q;
}

function getBestIntentSliceByPnl(
  {
    asks,
    bids,
    buyFee,
    sellFee,
    qMax,
  }: {
    asks: L2Level[];
    bids: L2Level[];
    buyFee: number;
    sellFee: number;
    qMax: number;
  }
): BestIntentSliceResult | null {
  let i = 0;
  let j = 0;

  let buyQty = 0;
  let buyNotional = 0;
  let sellNotional = 0;

  let bestPnl = -Infinity;
  let bestQty = 0;
  let bestQBuy = 0;
  let bestQSell = 0;
  let bestBuyPxWorst = NaN;
  let bestSellPxWorst = NaN;

  let askRemainingQty = asks.length > 0 ? Number(asks[0][1]) : 0;
  let bidRemainingQty = bids.length > 0 ? Number(bids[0][1]) : 0;

  while (i < asks.length && j < bids.length) {
    const askPx = Number(asks[i][0]);
    const bidPx = Number(bids[j][0]);

    if (!Number.isFinite(askPx) || !Number.isFinite(bidPx) || askPx <= 0 || bidPx <= 0 || bidPx <= askPx) {
      break;
    }
    if (!Number.isFinite(askRemainingQty) || !Number.isFinite(bidRemainingQty) || askRemainingQty <= 0 || bidRemainingQty <= 0) {
      break;
    }

    const qBuyRemaining = qMax - buyNotional;
    const qSellRemaining = qMax - sellNotional;
    if (qBuyRemaining <= 0 || qSellRemaining <= 0) {
      break;
    }

    const qtyCapByBuy = qBuyRemaining / askPx;
    const qtyCapBySell = qSellRemaining / bidPx;
    const qtyStep = Math.min(askRemainingQty, bidRemainingQty, qtyCapByBuy, qtyCapBySell);
    if (!Number.isFinite(qtyStep) || qtyStep <= 0) {
      break;
    }

    buyQty += qtyStep;
    buyNotional += qtyStep * askPx;
    sellNotional += qtyStep * bidPx;

    const pnl = sellNotional - buyNotional - sellNotional * sellFee - buyNotional * buyFee;

    if (pnl > bestPnl) {
      bestPnl = pnl;
      bestQty = buyQty;
      bestQBuy = buyNotional;
      bestQSell = sellNotional;
      bestBuyPxWorst = askPx;
      bestSellPxWorst = bidPx;
    } else if (pnl < bestPnl) {
      break;
    }

    askRemainingQty -= qtyStep;
    bidRemainingQty -= qtyStep;

    if (askRemainingQty <= 1e-12) {
      i += 1;
      askRemainingQty = i < asks.length ? Number(asks[i][1]) : 0;
    }
    if (bidRemainingQty <= 1e-12) {
      j += 1;
      bidRemainingQty = j < bids.length ? Number(bids[j][1]) : 0;
    }
  }

  if (bestQty <= 0 || !Number.isFinite(bestPnl)) {
    return null;
  }

  return {
    targetQty: bestQty,
    qBuy: bestQBuy,
    qSell: bestQSell,
    buyPxWorst: bestBuyPxWorst,
    sellPxWorst: bestSellPxWorst,
    expectedPnl: bestPnl,
  };
}

function key(ex: ExchangeId, sym: string): string {
  return `${ex}|${sym}`;
}

export function computeIntentsForSym({ sym, latest, nowMs, cfg, exState }: ComputeIntentsForSymArgs): TradeIntentDraft[] {
  const rt = runtime as EngineRuntime;
  const intents: TradeIntentDraft[] = [];

  for (const buyEx of cfg.enabledExchanges) {
    for (const sellEx of cfg.enabledExchanges) {
      if (buyEx === sellEx) continue;

      const buy = latest.get(key(buyEx, sym));
      const sell = latest.get(key(sellEx, sym));
      if (!buy || !sell) continue;

      const buyS = exState.getExchangeState(buyEx) as { exchangeQuality?: string; anyAgeMs?: number } | null;
      if (!buyS || buyS.exchangeQuality === EXCHANGE_QUALITY.STOP) {
        if (buyS?.anyAgeMs) {
          log.debug({ reason: 'bad exchange quality', exchange: buyEx, buyS }, 'dropped trade');
        }
        continue;
      }

      const sellS = exState.getExchangeState(sellEx) as { exchangeQuality?: string; anyAgeMs?: number } | null;
      if (!sellS || sellS.exchangeQuality === EXCHANGE_QUALITY.STOP) {
        if (sellS?.anyAgeMs) {
          log.debug({ reason: 'bad exchange quality', exchange: sellEx, sellS }, 'dropped trade');
        }
        continue;
      }

      const buyAsk = bestAskPx(buy.asks);
      const sellBid = bestBidPx(sell.bids);
      if (!Number.isFinite(buyAsk) || !Number.isFinite(sellBid)) continue;

      const buyInfo = getEx(sym, buyEx);
      const sellInfo = getEx(sym, sellEx);
      if (!buyInfo?.enabled || !sellInfo?.enabled) continue;

      const buyFee = buyInfo.taker_fee;
      const sellFee = sellInfo.taker_fee;
      const raw = rawSpread(buyAsk, sellBid);
      const addRawBuffer = getAddRawSpreadBuffer({ sym, buyEx, sellEx, rt });
      const net1 = raw - (buyFee + sellFee + rt.rawBuffer + addRawBuffer);
      if (net1 <= 0) continue;

      const bestSlice = getBestIntentSliceByPnl({
        asks: buy.asks,
        bids: sell.bids,
        buyFee,
        sellFee,
        qMax: rt.qMax,
      });
      if (!bestSlice) continue;

      const {
        targetQty,
        qBuy: qBuyTarget,
        qSell: qSellTarget,
        buyPxWorst,
        sellPxWorst,
        expectedPnl,
      } = bestSlice;

      if (qBuyTarget < rt.qMin || qSellTarget < rt.qMin) continue;
      if (!Number.isFinite(buyPxWorst) || !Number.isFinite(sellPxWorst)) continue;

      const raw2 = rawSpread(buyPxWorst, sellPxWorst);
      const net2 = raw2 - (buyFee + sellFee);
      if (net2 <= 0) {
        log.debug({ reason: 'stage2 pnl max is not profitable anymore', buyPxWorst, sellPxWorst, raw2 }, 'dropped trade');
        continue;
      }

      intents.push({
        symbol: sym,
        buyEx,
        sellEx,
        qBuy: qBuyTarget,
        qSell: qSellTarget,
        targetQty,
        net: net2,
        buyPxEff: targetQty > 0 ? qBuyTarget / targetQty : 0,
        sellPxEff: targetQty > 0 ? qSellTarget / targetQty : 0,
        expectedPnl: qSellTarget - qBuyTarget - qSellTarget * sellFee - qBuyTarget * buyFee,
        buyAsk,
        sellBid,
        buyPxWorst,
        sellPxWorst,
      });
    }
  }

  return intents;
}

export {
  getQWithinSlippage,
  getQFromQtyL2,
};
