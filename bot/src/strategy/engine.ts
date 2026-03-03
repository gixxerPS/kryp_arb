import { getLogger } from '../common/logger';
import { EXCHANGE_QUALITY } from '../common/constants';
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

// fuer 10 levels noch OK zu iterieren
export function bestBidPx(bids: L2Level[] | undefined | null): number {
  let best = -Infinity;
  for (const lvl of bids || []) {
    const px = Number(lvl?.[0]);
    if (Number.isFinite(px) && px > best) best = px;
  }
  return Number.isFinite(best) ? best : NaN;
}

// fuer 10 levels noch OK zu iterieren
export function bestAskPx(asks: L2Level[] | undefined | null): number {
  let best = Infinity;
  for (const lvl of asks || []) {
    const px = Number(lvl?.[0]);
    if (Number.isFinite(px) && px < best) best = px;
  }
  return Number.isFinite(best) ? best : NaN;
}

/**
 * side: 'buy' (asks) oder 'sell' (bids)
 * levels: [[price, qty], ...] (Strings oder Numbers)
 * slippagePct: z.B. 0.10 für 0.10% (also config in Prozent)
 * qMin/qMax in USDT
 *
 *   bids: [ ["0.10000000","2978.60000000"],["0.09990000","52469.90000000"],...
 *   asks: [ ["0.10010000","10071.60000000"],["0.10020000","58914.50000000"],...
 */
/**
 * @function getQWithinSlippage
 *
 * @description
 * Summiert die verfügbare Liquidität (Quote-Währung, z. B. USDT) eines Orderbuchs
 * innerhalb eines Slippage-Bands relativ zum Bestpreis und clamped das Ergebnis
 * auf einen erlaubten Handelsbereich.
 *
 * Die Funktion wird für Stage-2 (Liquiditätsprüfung) verwendet und beantwortet
 * die Frage:
 * "Wie viel Quote kann ich handeln, ohne den Preis um mehr als slippage_pct
 * gegenüber dem Top-of-Book zu verschlechtern?"
 *
 * @notes
 * - Es wird eine Sortierung der Levels vorausgesetzt.
 */
function getQWithinSlippage(
  { levels, slippagePct, qMax }: { levels: L2Level[]; slippagePct: number; qMax: number }
): QWithinSlippageResult {
  const l = levels.length;
  const bestPx = Number(levels[0][0]); // best price
  let targetQty = Number(levels[0][1]);
  let q = bestPx * targetQty;
  let dir = 1; // 1 = buy, -1 = sell
  if (l > 1) {
    dir = Number(levels[1][0]) > Number(levels[0][0]) ? 1 : -1;
  } else { // nur 1 level (0 duerfte nicht vorkommen)
    if (bestPx === 0.0) { // avoid div-by-zero, should not happen
      return { q, limLvlIdx: 0, pxLim: 0, targetQty };
    }
    // ganzes qMax wenn es passt, sonst ganzes level
    targetQty = qMax < q ? qMax / bestPx : Number(levels[0][1]);
  }
  const pxLim = dir === 1 ? bestPx * (1 + slippagePct * 0.01) : bestPx * (1 - slippagePct * 0.01);
  let i = 1;
  for (; i < l; i++) {
    const px = Number(levels[i][0]);
    const qty = Number(levels[i][1]);

    if (px * dir > pxLim * dir) { // preis ist nicht mehr in erlaubter slippage spanne ?
      break;
    }

    const qLevel = px * qty;
    const qRemaining = qMax - q;

    if (qRemaining <= 0) break;

    if (qLevel <= qRemaining) { // ganzes level passt noch rein
      q += qLevel;
      targetQty += qty;
    } else { // nur anteiliges level passt rein
      if (px === 0.0) { // avoid div-by-zero, should not happen
        return { q, limLvlIdx: 0, pxLim: 0, targetQty };
      }
      const partialQty = qRemaining / px;
      q += qRemaining;
      targetQty += partialQty;
      i += 1; // level wurde noch benutzt -> unten -1 also hier vorher erhoehen
      break;
    }
  }
  q = Math.min(qMax, q);
  return { q, limLvlIdx: i - 1, pxLim, targetQty };
}

/**
 * Nachdem die targetQty aus min(buyQty, sellQty) bestimmt wurde muss die erwartete q
 * nochmal mit der targetQty praezise bestimmt werden. einmal fuer buy leg und einmal 
 * fuer sell leg
 * @param param0 
 * @returns q
 */
function getQFromQtyL2(
  { levels, targetQty }: { levels: L2Level[]; targetQty: number }
): number {
  let i = 0, q = 0, qtyRemaining = targetQty;
  const l = levels.length;
  for (; i < l; i++) {
    const px = Number(levels[i][0]);
    const qty = Number(levels[i][1]);
    if (qtyRemaining <= qty) { // level nur noch anteilig ?
      q += px * qtyRemaining;
      qtyRemaining = 0;
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

// latest: Map("ex|sym" -> l2 object)
// returns: array of intents
export function computeIntentsForSym({ sym, latest, fees, nowMs, cfg, exState }: ComputeIntentsForSymArgs): TradeIntentDraft[] {
  const rt = runtime as EngineRuntime;
  const intents: TradeIntentDraft[] = [];

  for (const buyEx of cfg.bot.exchanges) {
    for (const sellEx of cfg.bot.exchanges) {
      if (buyEx === sellEx) continue;

      const buy = latest.get(key(buyEx, sym));
      const sell = latest.get(key(sellEx, sym));
      if (!buy || !sell) continue;

      // NEU: nur weil ein datenpunkt alt ist heisst das nicht
      // dass er nicht up-to-date sein kann!
      // naemlich wenn kaum aktivitaet auf den boersen ist, wird preis ggf
      // laenger nicht aktualisisert!
      // deshalb ist der ansatz mit max_book_age_ms nicht praxistauglich
      //
      // stattdessen: unabhaengig kommunikationszustand zu exchanges auswerten (common/exchange_state.js)
      // und hier lediglich pruefen
      const buyS = exState.getExchangeState(buyEx) as any;
      if (!buyS || buyS.exchangeQuality === EXCHANGE_QUALITY.STOP) {
        if (buyS?.anyAgeMs) {
          // log nur wenn schon was empfangen wurde sonst kommen nach startup bis zum ersten heartbeat update schon meldungen
          log.debug({ reason: 'bad exchange quality', exchange: buyEx, buyS }, 'dropped trade');
        }
        continue;
      }
      const sellS = exState.getExchangeState(sellEx) as any;
      if (!sellS || sellS.exchangeQuality === EXCHANGE_QUALITY.STOP) {
        if (sellS?.anyAgeMs) {
          // log nur wenn schon was empfangen wurde sonst kommen nach startup bis zum ersten heartbeat update schon meldungen
          log.debug({ reason: 'bad exchange quality', exchange: sellEx, sellS }, 'dropped trade');
        }
        continue;
      }
      //
      // ALT: ist einer der stream datenpunkte aelter als 1500 ms?
      // koennte auf stream problem hindeuten.
      // der preis ist moeglicherweise laengst weggelaufen -> kein trade!!!
      // const maxAgeMs = Number(cfg.bot.max_book_age_ms ?? 1500);
      // if (nowMs - buy.tsMs > maxAgeMs) continue;
      // if (nowMs - sell.tsMs > maxAgeMs) continue;

      const buyAsk = bestAskPx(buy.asks);
      const sellBid = bestBidPx(sell.bids);
      if (!Number.isFinite(buyAsk) || !Number.isFinite(sellBid)) continue;

      // STAGE 1: trade-chance auf basis vom net spread erkennen
      const buyFee = getEx(sym, buyEx)!.taker_fee;
      const sellFee = getEx(sym, sellEx)!.taker_fee;
      const raw = rawSpread(buyAsk, sellBid);
      const net1 = raw - (buyFee + sellFee + rt.rawBuffer);
      if (net1 <= 0) {
        continue;
      }

      // STAGE 2: max moegliche ordergroesse anhand von L2 daten ermitteln
      const qBuy = getQWithinSlippage({ levels: buy.asks, slippagePct: rt.slippage, qMax: rt.qMax });
      const qSell = getQWithinSlippage({ levels: sell.bids, slippagePct: rt.slippage, qMax: rt.qMax });

      if (qBuy.q < rt.qMin || qSell.q < rt.qMin) {
        continue;
      }

      // Worst-case Slippage bis zur Band-Grenze (nicht abhängig von qEff!)
      // Es wird ja eine Seite begrenzt verursacht also potentiell weniger slippage.
      // Wenn aber auch fuer diese Seite mit dem slippage grenzlevelIdx gerechnet wird
      // ist (sollte sein) der reale gewinn hoeher als der hier berechnete.
      // Im Umkehrschluss bedeutet das hier werden u.U. Trades ausgelassen.
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
      const expectedPnl = qSellTarget - qBuyTarget - qSellTarget*sellFee - qBuyTarget*buyFee;

      intents.push({
        symbol: sym,
        buyEx,
        sellEx,
        qBuy: qBuyTarget,
        qSell: qSellTarget,
        expectedPnl,
        targetQty,
        net: net2,
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
  getQFromQtyL2
};
