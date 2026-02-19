'use strict';

const { getLogger } = require('../common/logger');
const log = getLogger('executor');
const { getExState } = require('../common/exchange_state');
const { getEx } = require('../common/symbolinfo');
const { getExchange, getBotCfg } = require('../common/config');
const { safeCall } = require('../common/async');

const appBus = require('../bus');

const binanceAdapter = require('./adapter/binance_ws');

function getEnabledSymbols(cfg) {
  if (Array.isArray(cfg.symbols)) return cfg.symbols;
  if (cfg.pairs && typeof cfg.pairs === 'object') {
    return Object.entries(cfg.pairs).filter(([, v]) => v?.enabled !== false).map(([k]) => k);
  }
  if (Array.isArray(cfg.routes)) {
    return cfg.routes.filter(r => r?.enabled !== false).map(r => r.sym).filter(Boolean);
  }
  return [];
}

module.exports = async function startExecutor({ cfg }, deps = {}) {
  const bus = deps.bus ?? appBus;
  const exState = deps.exState ?? getExState();
  const adaptersFromDeps = deps.adapters;
  const nowFn = deps.nowFn ?? (() => Date.now());

  const enabledSymbols = getEnabledSymbols(cfg);

  const exStateArr = exState.getAllExchangeStates();

  const CFG_AUTO_FIX_FAILED_ORDERS = getBotCfg().auto_fix_failed_orders;
  
  // adapters ermitteln fuer exchanges die bei start enabled sind
  const adapters = adaptersFromDeps ?? {};
  for (const ex of exStateArr) {
    if (ex.enabled) {
      if (ex.exchange === 'binance') {
        adapters.binance = binanceAdapter;
      } else if (ex.exchange === 'bitget') {
        ;//adapters.bitget = binanceAdapter;
      } else if (ex.exchange === 'gate') {
        ;//adapters.gate = binanceAdapter;
      }
    }
  }

  // init adapters
  for (const [ex, ad] of Object.entries(adapters)) {
    await ad.init(cfg);
  }

  // test um zu pruefen ob rabatte auch wirklich hinterlegt sind
  // adapters.binance.getAccountCommission('AXSUSDC');

  const state = {
    // binance : {
    //   balances : {BNB:0.177, USDC:1234, ...},
    //   orderRateLimits: [{interval:'SECOND', intervalNum:10, limit:50, count:1}, 
    //      {{interval:'DAY', intervalNum:1, limit:160000, count:1}}]
    // }
   };
   
  // startup balances
  for (const [ex, ad] of Object.entries(adapters)) {
    state[ex] = {
      balances : await ad.getStartupBalances( )
    }
  }

  log.debug({state}, 'initialized');

  // TEST
  // await adapters.binance.placeOrder(true, {
  //   symbol: 'AXSUSDC',
  //   side: 'BUY',
  //   type: 'MARKET',
  //   // qty/quoteQty je nach Ansatz
  //   quantity:5,
  //   orderId: '123456789',
  // });

  // spaeter:
  // for (const [ex, ad] of Object.entries(adapters)) {
  //   await ad.subscribeUserData((evt) => onUserEvent(ex, evt));
  // }

  // TODO: so soll die architektur spaeter aussehen:
  let busy = false;

  async function handleIntent(intent) {
    if (busy) {
      log.warn({ reason:'executor busy', intent }, 'dropping intent');
      return;
    }
    busy = true;
    try {
      const { sym, buyEx, sellEx, targetQty, q, id } = intent; // sym ist canonical
      const buyAd = adapters[buyEx];
      const sellAd = adapters[sellEx];
      if (!buyAd || !sellAd) {
        log.warn({ reason:'adapter missing', intent, buyEx, sellEx }, 'dropping intent');
        return;
      }
      
      //=======================================================================
      // 1.1) prechecks BUY (gegen den aktuellen bestands snapshot)
      //=======================================================================
      const resBuyCheck = marketOrderPrecheckOk({
        side: 'BUY',
        targetQty,
        q,
        prepSymbolInfo: getEx(sym, buyEx),
        exState:  state[buyEx],
        feeRate: getExchange(buyEx).taker_fee_pct*0.01, // @TODO: kann optimiert werden da faktor 1/100 statisch
      });
      if (!resBuyCheck.ok) {
        log.warn({ reason:'precheck buy order failed', intent, buyEx, checkReason:resBuyCheck.reason },
          'dropping intent');
        return;
      }
      //=======================================================================
      // 1.2) prechecks SELL (gegen den aktuellen bestands snapshot)
      //=======================================================================
      const resSellCheck = marketOrderPrecheckOk({
        side: 'SELL',
        targetQty,
        q,
        prepSymbolInfo: getEx(sym, sellEx),
        exState:  state[sellEx],
        feeRate: getExchange(sellEx).taker_fee_pct*0.01, // @TODO: kann optimiert werden da faktor 1/100 statisch
      });
      if (!resSellCheck.ok) {
        log.warn({ reason:'precheck sell order failed', intent, sellEx, checkReason:resSellCheck.reason },
          'dropping intent');
        return;
      }
      //=======================================================================
      // 2) orders schicken (parallel)
      //=======================================================================
      const buyParams = {
        type: 'MARKET',
        side: 'BUY',
        symbol:getEx(sym, buyEx).orderKey,
        quantity:targetQty,
        orderId: id,
      };
      const buyPO  = buyAd.placeOrder(false, buyParams); 
      const sellParams = {
        type: 'MARKET',
        side: 'SELL',
        symbol:getEx(sym, sellEx).orderKey,
        quantity:targetQty,
        orderId: id,
      };
      const sellPO = sellAd.placeOrder(false, sellParams);
      // Promises sofort starten (parallel), aber Fehler in op() abfangen
      const [buyR, sellR] = await Promise.allSettled([buyPO, sellPO]);
      
      //=======================================================================
      // 3) exchange antwort auswerten
      //=======================================================================
      const buyOk  = buyR.status === 'fulfilled' // promise result
        && buyR.value?.status == 'FILLED';       // order result
      const sellOk = sellR.status === 'fulfilled' // promise result
        && sellR.value?.status == 'FILLED';      // order result
      if (buyOk && sellOk) {
        log.debug({
            intentId: id,
            sym,
            buyEx,
            sellEx,
            buyQ               : buyR.value.cummulativeQuoteQty,
            buyP               : buyR.value.price,
            buyCommission      : buyR.value.commission,
            buyCommissionAsset : buyR.value.commissionAsset,
            sellQ              : sellR.value.cummulativeQuoteQty,
            sellP              : sellR.value.price,
            sellCommission     : sellR.value.commission,
            sellCommissionAsset: sellR.value.commissionAsset,
          },
          'orders executed'
        );
        // TODO: monitor fills / reconcile, invalidate balances snapshot
        const buyExQuoteKey = getEx(sym, buyEx).quote; // USDC
        state[buyEx].balances[buyExQuoteKey] -= intent.q; // bought 350 AXS for 500 USDC
        const buyExBaseKey = getEx(sym, buyEx).base; // AXS
        state[buyEx].balances[buyExBaseKey] += targetQty; // bought 350 AXS for 500 USDC

        const sellExQuoteKey = getEx(sym, sellEx).quote; // USDC
        state[sellEx].balances[sellExQuoteKey] += intent.q; // sold 350 AXS for 500 USDC
        const sellExBaseKey = getEx(sym, buyEx).base; // AXS
        state[sellEx].balances[sellExBaseKey] -= targetQty; // sold 350 AXS for 500 USDC
      
        bus.emit('trade:orders_ok', {
          intent_id: id,
          ts: new Date().toISOString(),
          symbol: symCanon,
          buy:  normalizeOrderResult(buyR.value, 'buy',  buyEx,  symCanon),
          sell: normalizeOrderResult(sellR.value, 'sell', sellEx, symCanon),
        });
      
      } else if (buyOk && !sellOk) {
        log.error({
          intentId: id,
          sym,
          buyEx,
          sellEx,
          sellErr: sellR.ok ? null : sellR.errObj,
          sellRes: sellR.ok ? sellR.value : null,
        }, 'sell failed after buy placed');
        if (!CFG_AUTO_FIX_FAILED_ORDERS) { // nur wenn auch konfiguriert, versuchen zu reparieren
          return;
        }
        // Minimal: versuchen BUY zu canceln (wenn market sofort fillt, bringt cancel nichts, 
        // aber bei rejected/partial schon)
        const resCancelBuy = await safeCall(() => buyAd.cancelOrder({ 
          symbol: buyParams.symbol, origClientOrderId: buyParams.orderId }) );
        if (!resCancelBuy.ok) {
          log.warn({ intentId: id, buyEx, sym, orderId: buyParams.orderId, cancelErr: resCancelBuy.errObj,
           }, 'cancel buy failed');
          // wenn buy auch nicht mehr gecancelt werden konnte, dann wieder verkaufen, da sonst die
          // bestaende weglaufen
          const resResell = await safeCall(() => buyAd.placeOrder({
              symbol: buyParams.symbol,
              side: 'SELL',
              type: 'MARKET',
              quantity: buyParams.quantity,
              orderId: `${buyParams.clientOrderId}-RS`,
            })
          );
          if (!resResell.ok) {
            log.warn({ intentId: id, buyEx, sym, orderId: buyParams.orderId }, 'resell failed');
          }
        }
      } else if (!buyOk && sellOk) {
        log.error({
          intentId: id,
          sym,
          buyEx,
          sellEx,
          buyErr: buyR.ok ? null : buyR.errObj,
          buyRes: buyR.ok ? buyR.value : null,
        }, 'buy failed after sell placed');
        if (!CFG_AUTO_FIX_FAILED_ORDERS) { // nur wenn auch konfiguriert, versuchen zu reparieren
          return;
        }
        // Minimal: versuchen SELL zu canceln (wenn market sofort fillt, bringt cancel nichts, 
        // aber bei rejected/partial schon)
        const resCancelSell = await safeCall(() => sellAd.cancelOrder({ 
          symbol: sellParams.symbol, origClientOrderId: sellParams.orderId }) );
        if (!resCancelSell.ok) {
          log.warn({ intentId: id, sellEx, sym, orderId: sellParams.orderId, cancelErr: resCancelSell.errObj }, 
            'cancel sell failed');

          // wenn sell auch nicht mehr gecancelt werden konnte, dann wieder kaufen, da sonst die
          // bestaende weglaufen
          const resRebuy = await safeCall(() => sellAd.placeOrder({
              symbol: sellParams.symbol,
              side: 'BUY',
              type: 'MARKET',
              quantity: sellParams.quantity,
              orderId: `${sellParams.orderId}-RB`,
            }) );
          if (!resRebuy.ok) {
            log.warn({ intentId: id, sellEx, sym, orderId: sellParams.orderId,  rebuyErr: resRebuy.errObj, }, 
              'rebuy failed');
          }
        }
      } else { // beide failed
        log.warn({
            intentId: id,
            sym,
            buyEx,
            sellEx,
            buyErr: buyR.reason,
            sellErr: sellR.reason,
          }, 'both orders failed');
      }
    } catch (err) {
      log.error({ err, intent }, 'handle intent failed');
    } finally {
      busy = false;
    }
  }

  // subscription
  // bus.on('trade:intent', (intent) => {
  //   // als erstes state aktualisieren: ist exchange noch enabled? oder von 
  //   // ui (telegram / webserver) disabled worden?
  //   handleIntent(intent).catch((err) => {
  //     log.error({ err, intent }, 'executor intent failed');
  //   });
  // });

  function getStatus() {
    return {
      startedAtMs: state.startedAtMs,
      balancesByEx: state.balancesByEx,
    };
  }
  log.debug({ }, 'executor started');
  return { 
    state, 
    _state: state,      // optional (wenn du intern/Debug brauchst)
    _adapters: adapters, // optional (für Debug/Tests)
    getStatus 
  };
}
