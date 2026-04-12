import { EXCHANGE_QUALITY } from '../common/constants';
import { getLogger } from '../common/logger';
import { getEx } from '../common/symbolinfo';

import type { AppConfig } from '../types/config';
import type { ExchangeId } from '../types/common';
import type { ComputeIntentsForSymArgs, L2Level, TradeIntentDraft } from '../types/strategy';

const log = getLogger('strategy');

type EngineRuntime = {
  rawBuffer: number;
  slippage: number;
  qMin: number;
  qMax: number;
};

let runtime: EngineRuntime | null = null;

export function initStrategyEngine(cfg: AppConfig): void {
  runtime = {
    rawBuffer: Number(cfg.bot.raw_spread_buffer_pct) * 0.01,
    slippage: Number(cfg.bot.slippage_pct) * 0.01,
    qMin: Number(cfg.bot.q_min_usdt),
    qMax: Number(cfg.bot.q_max_usdt),
  };
}

function rawSpread(buyAsk: number, sellBid: number): number {
  return (sellBid - buyAsk) / buyAsk;
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
): { q: number; limLvlIdx: number; pxLim: number; targetQty: number } {
  const bestPx = Number(levels[0][0]);
  let targetQty = Number(levels[0][1]);
  let q = bestPx * targetQty;
  let dir = 1;

  if (levels.length > 1) {
    dir = Number(levels[1][0]) > Number(levels[0][0]) ? 1 : -1;
  } else {
    if (bestPx === 0) return { q, limLvlIdx: 0, pxLim: 0, targetQty };
    targetQty = qMax < q ? qMax / bestPx : Number(levels[0][1]);
  }

  const pxLim = dir === 1 ? bestPx * (1 + slippage) : bestPx * (1 - slippage);

  let i = 1;
  for (; i < levels.length; i += 1) {
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
      const net1 = raw - (buyFee + sellFee + rt.rawBuffer);
      if (net1 <= 0) continue;

      const qBuy = getQWithinSlippage({ levels: buy.asks, slippage: rt.slippage, qMax: rt.qMax });
      const qSell = getQWithinSlippage({ levels: sell.bids, slippage: rt.slippage, qMax: rt.qMax });
      if (qBuy.q < rt.qMin || qSell.q < rt.qMin) continue;

      const buyPxWorst = Number(buy.asks[qBuy.limLvlIdx][0]);
      const sellPxWorst = Number(sell.bids[qSell.limLvlIdx][0]);
      if (!Number.isFinite(buyPxWorst) || !Number.isFinite(sellPxWorst)) continue;

      const raw2 = rawSpread(buyPxWorst, sellPxWorst);
      const net2 = raw2 - (buyFee + sellFee);
      if (net2 <= 0) {
        log.debug({ reason: 'slippage makes it unprofitable', buyPxWorst, sellPxWorst, raw2 }, 'dropped trade');
        continue;
      }

      const targetQty = Math.min(qBuy.targetQty, qSell.targetQty);
      const qBuyTarget = getQFromQtyL2({ levels: buy.asks, targetQty });
      const qSellTarget = getQFromQtyL2({ levels: sell.bids, targetQty });

      log.debug({asks:buy.asks, bids:sell.bids}, 'levels for intent');

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
