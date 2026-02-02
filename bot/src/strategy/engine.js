const { getLogger } = require('../logger');
const log = getLogger('strategy');

const { EXCHANGE_QUALITY } = require('../common/constants');

function rawSpread(buyAsk, sellBid) {
  return (sellBid - buyAsk) / buyAsk;
}

// fuer 10 levels noch OK zu iterieren
function bestBidPx(bids) {
  let best = -Infinity;
  for (const lvl of bids || []) {
    const px = Number(lvl?.[0]);
    if (Number.isFinite(px) && px > best) best = px;
  }
  return Number.isFinite(best) ? best : NaN;
}

// fuer 10 levels noch OK zu iterieren
function bestAskPx(asks) {
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
    //   bids: [ ["0.10000000","2978.60000000"],["0.09990000","52469.90000000"],...
    //   asks: [ ["0.10010000","10071.60000000"],["0.10020000","58914.50000000"],...
 */
/**
 * @function getQWithinSlippage
 *
 * @description
 * Summiert die verfügbare Liquidität (Quote-Währung, z. B. USDT) eines Orderbuchs
 * **innerhalb eines Slippage-Bands** relativ zum Bestpreis und clamped das Ergebnis
 * auf einen erlaubten Handelsbereich.
 *
 * Die Funktion wird für **Stage-2 (Liquiditätsprüfung)** verwendet und beantwortet
 * die Frage:
 * > „Wie viel Quote kann ich handeln, ohne den Preis um mehr als `slippage_pct`
 * > gegenüber dem Top-of-Book zu verschlechtern?“
 *
 * @param {Object} params
 * @param {Array.<[number, number]>} params.levels
 * @param {number} params.slippage_pct   Max. Slippage in Prozent (z. B. 0.10 = 0.10%)
 * @param {number} params.q_min           Minimale Quote-Größe
 * @param {number} params.q_max           Maximale Quote-Größe
 *
 * @returns {{
 *   q: number,
 *   limLvl: number,
 *   pxLim: number
 * }}
 * Ergebnis der Liquiditätsberechnung:
 * - `q`         - nutzbare Quote nach Clamping 
 * - `limLvlIdx` - array index in dem abgebrochen wurde (slippage verletzt oder array zu ende)
 * - `pxLim`     - Preisgrenze des Slippage-Bands
 *
 * @notes
 * - Es wird eine Sortierung der Levels vorausgesetzt.
 */
function getQWithinSlippage({ levels, slippagePct, qMax }) {
  let l = levels.length;
  let bestPx = levels[0][0]; // best price
  let q = bestPx * levels[0][1];
  let dir = 1; // 1 = buy, -1 = sell
  if (l > 1) {
    dir = levels[1][0] > levels[0][0] ? 1 : -1; 
  }
  const pxLim = dir == 1 ? bestPx * (1 + slippagePct*0.01) : bestPx * (1 - slippagePct*0.01);
  let i = 1;
  let targetQty = 0;
  for (; i < l; i++) {
    let px = levels[i][0];
    let qty = levels[i][1];
    //console.log({px,qty,i,pxLim,dir, lvl10:levels[1][0], lvl00:levels[0][0]});

    if (px * dir > pxLim * dir) { // preis ist nicht mehr in erlaubter slippage spanne ?
      //console.log(`break at i=${i}`);
      break;
    }

    const qLevel = px * qty;
    const qRemaining = qMax - q;

    if (qRemaining <= 0) break;

    if (qLevel <= qRemaining) { // ganzes level passt noch rein
      q += qLevel;
      targetQty += qty;
    } else { // nur anteiliges level passt rein
      const partialQty = qRemaining / px;
      q += qRemaining;
      targetQty += partialQty;
      break;
    }
  }
  q = Math.min(qMax, q);
  //console.log(`done. i=${i}`);
  return { q, limLvlIdx: i-1, pxLim, targetQty };
}

// latest: Map("ex|sym" -> l2 object)
// returns: array of intents
function computeIntentsForSym({ sym, latest,fees, nowMs, cfg, exState }) {
  const rawBuffer = Number(cfg.bot.raw_spread_buffer_pct) * 0.01;
  const slippage = Number(cfg.bot.slippage_pct) * 0.01;
  const qMin = Number(cfg.bot.q_min_usdt);
  const qMax = Number(cfg.bot.q_max_usdt);

  const intents = [];

  function key(ex, sym) {
    return `${ex}|${sym}`;
  }
  //console.log(cfg);
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
      const buyS = exState.getExchangeState(buyEx);
      if (!buyS || buyS.exchangeQuality === EXCHANGE_QUALITY.STOP) {
        if (buyS.anyAgeMs !== null) { // log nur wenn schon was empfangen wurde sonst kommen nach startup bis zum ersten heartbeat update schon meldungen
          log.debug({reason:'bad exchange quality', exchange: buyEx, buyS}, 'dropped trade');
        }
        continue;
      }
      const sellS = exState.getExchangeState(sellEx);
      if (!sellS || sellS.exchangeQuality === EXCHANGE_QUALITY.STOP) {
        if (sellS.anyAgeMs !== null) { // log nur wenn schon was empfangen wurde sonst kommen nach startup bis zum ersten heartbeat update schon meldungen
          log.debug({reason:'bad exchange quality', exchange: sellEx, sellS}, 'dropped trade');
        }
        continue;
      }
      //
      // ALT: ist einer der stream datenpunkte aelter als 1500 ms?
      // koennte auf stream problem hindeuten. 
      // der preis ist moeglicherweise laengst weggelaufen -> kein trade!!!
      //const maxAgeMs = Number(cfg.bot.max_book_age_ms ?? 1500);
      //if (nowMs - buy.tsMs > maxAgeMs) {
      //  //log.warn({
      //  //  symbol: sym,
      //  //  buyEx,
      //  //  ageMs: nowMs - buy.tsMs,
      //  //  maxAgeMs,
      //  //  tsMs: buy.tsMs,
      //  //}, 'stale buy book');
      //  continue;
      //}
      //if (nowMs - sell.tsMs > maxAgeMs) {
      //  //log.warn({
      //  //  symbol: sym,
      //  //  sellEx,
      //  //  ageMs: nowMs - sell.tsMs,
      //  //  maxAgeMs,
      //  //  tsMs: sell.tsMs,
      //  //}, 'stale buy book');
      //  continue;
      //}
      const buyAsk = bestAskPx(buy.asks);
      const sellBid = bestBidPx(sell.bids);
      if (!Number.isFinite(buyAsk) || !Number.isFinite(sellBid)) continue;

      // STAGE 1: trade-chance auf basis vom net spread erkennen

      const raw = rawSpread(buyAsk, sellBid);
      const buyFee = fees[buyEx].taker_fee_pct * 0.01;
      const sellFee = fees[sellEx].taker_fee_pct * 0.01;
      const net1 = raw - (buyFee + sellFee + rawBuffer); // zb: 0.31 - (0.1 + 0.1 + 0.05) = 0.06 % 
      if (net1 <= 0) {
        continue; // kein profit? kein trade!
      }

      // STAGE 2: max moegliche ordergroesse anhand von L2 daten ermitteln
      let par = {levels:buy.asks, slippagePct: cfg.bot.slippage_pct, qMax: qMax};
      const qBuy = getQWithinSlippage({levels:buy.asks, slippagePct: cfg.bot.slippage_pct, qMax: qMax});
      const qSell = getQWithinSlippage({levels:sell.bids, slippagePct: cfg.bot.slippage_pct, qMax: qMax});
      
      if (qBuy.q < qMin || qSell.q < qMin) {
        log.debug({reason:'not enough liquidity on orderbook',
          qBuy:qBuy.q, qSell:qSell.q, qMin, buyEx, sellEx, buyAsks:buy.asks, sellBids:sell.bids},
          'dropped trade');
        continue;
      }
      const qEff = Math.min(qBuy.q, qSell.q);

      // Worst-case Slippage bis zur Band-Grenze (nicht abhängig von qEff!)
      // Es wird ja eine Seite begrenzt verursacht also potentiell weniger slippage.
      // Wenn aber auch fuer diese Seite mit dem slippage grenzlevelIdx gerechnet wird
      // ist (sollte sein) der reale gewinn hoeher als der hier berechnete.
      // Im Umkehrschluss bedeutet das hier werden u.U. Trades ausgelassen
      const buyPxWorst = buy.asks[qBuy.limLvlIdx][0];
      const sellPxWorst = sell.bids[qSell.limLvlIdx][0];
      if (!Number.isFinite(buyPxWorst) || !Number.isFinite(sellPxWorst)) continue;

      const raw2 = rawSpread(buyPxWorst, sellPxWorst);
      const net2 = raw2 - (buyFee + sellFee);
      if (net2 <= 0) {
        log.debug({reason:'slippage makes it unprofitable', buyPxWorst, sellPxWorst, raw2}, 'dropped trade');
        continue;
      }

      // TODO:
      const targetQty = 0;

      const intent = {
        symbol: sym,
        buyEx,
        sellEx,
        q: qEff,
        targetQty,
        net:net2,
        buyAsk,
        sellBid,
      };
      intents.push(intent);
    }
  }
  return intents;
}

module.exports = { 
  computeIntentsForSym,
  bestAskPx,
  bestBidPx,
  getQWithinSlippage
};

