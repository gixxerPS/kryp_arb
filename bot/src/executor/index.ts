import { getLogger } from '../common/logger';
const log = getLogger('executor');
import { getExState } from '../common/exchange_state';
import { getEx } from '../common/symbolinfo';
import { getExchange, getBotCfg } from '../common/config';
import { safeCall, isFulfilled } from '../common/async';
import { marketOrderPrecheckOk } from './order_precheck';

import * as appBus from '../bus';
import { adapter as binanceAdapter } from './adapter/binance_ws';
import { adapter as gateAdapter } from './adapter/gate_ws';

import type { AppConfig } from '../types/config';
import type { ExchangeId, Balances } from '../types/common';
import { OrderTypes, OrderSides } from '../types/common';
import type { ExecutorAdapter, RuntimeState, PlaceOrderParams } from '../types/executor';
import type { TradeIntent } from '../types/strategy';

type Deps = {
  bus?: any;
  exState?: any;
  adapters?: Partial<Record<ExchangeId, ExecutorAdapter>>;
  nowFn?: () => number;
};



// function getEnabledSymbols(cfg: AppConfig) {
//   if (Array.isArray(cfg.symbols)) return cfg.symbols;
//   if (cfg.pairs && typeof cfg.pairs === 'object') {
//     return Object.entries(cfg.pairs).filter(([, v]) => v?.enabled !== false).map(([k]) => k);
//   }
//   if (Array.isArray(cfg.routes)) {
//     return cfg.routes.filter(r => r?.enabled !== false).map(r => r.sym).filter(Boolean);
//   }
//   return [];
// }

export default async function startExecutor(
  { cfg }: { cfg: AppConfig },
  deps: Deps = {}
) {
  const bus = deps.bus ?? appBus;
  const exState = deps.exState ?? getExState();
  const adaptersFromDeps = deps.adapters;
  const nowFn = deps.nowFn ?? (() => Date.now());

  // const enabledSymbols = getEnabledSymbols(cfg);

  const exStateArr = exState.getAllExchangeStates();

  const CFG_AUTO_FIX_FAILED_ORDERS = getBotCfg().auto_fix_failed_orders;
  
  // adapters ermitteln fuer exchanges die bei start enabled sind
  const adapters: Partial<Record<ExchangeId, ExecutorAdapter>> = deps.adapters ?? {};
  for (const ex of exStateArr) {
    if (!ex.enabled) {
      return;
    }
    if (ex.exchange === 'binance') {
      adapters.binance = binanceAdapter;
      await adapters.binance.init(cfg);
    } else if (ex.exchange === 'bitget') {
      ;//adapters.bitget = binanceAdapter;
    } else if (ex.exchange === 'gate') {
      adapters.gate = gateAdapter;
      await adapters.gate.init(cfg);
    }
  }

  // test um zu pruefen ob rabatte auch wirklich hinterlegt sind
  // adapters.binance.getAccountCommission('AXSUSDC');

  const state: RuntimeState = {
    // binance : {
    //   balances : {BNB:0.177, USDC:1234, ...},
    //   orderRateLimits: [{interval:'SECOND', intervalNum:10, limit:50, count:1}, 
    //      {{interval:'DAY', intervalNum:1, limit:160000, count:1}}]
    // }
   };
   
  // startup balances
  for (const [ex, ad] of Object.entries(adapters)) {
    state[ex as ExchangeId] = {
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

  async function handleIntent(intent: TradeIntent) {
    if (busy) {
      log.warn({ reason:'executor busy', intent }, 'dropping intent');
      return;
    }
    busy = true;
    try {
      const { symbol, buyEx, sellEx, targetQty, q, id } = intent; // sym ist canonical
      const buyAd = adapters[buyEx];
      const sellAd = adapters[sellEx];
      if (!buyAd || !sellAd) {
        log.error({ reason:'adapter missing', intent, buyEx, sellEx }, 'dropping intent');
        return;
      }
      const buyExSymInfo = getEx(symbol, buyEx);
      const sellExSymInfo = getEx(symbol, sellEx);
      if (!buyExSymInfo || !sellExSymInfo) {
        log.error({ symbol, buyEx, sellEx }, 'symbolinfo missing');
        return;
      }
      
      //=======================================================================
      // 1.1) prechecks BUY (gegen den aktuellen bestands snapshot)
      //=======================================================================
      const resBuyCheck = marketOrderPrecheckOk({
        side: 'BUY',
        targetQty,
        q,
        prepSymbolInfo: buyExSymInfo,
        exState:  state[buyEx],
        balance_minimum_usdt: cfg.bot.balance_minimum_usdt,
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
        prepSymbolInfo: sellExSymInfo,
        exState:  state[sellEx],
        balance_minimum_usdt: cfg.bot.balance_minimum_usdt,
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
      const buyParams: PlaceOrderParams = {
        type: OrderTypes.MARKET,
        side: OrderSides.BUY,
        symbol: buyExSymInfo.orderKey,
        quantity:targetQty,
        orderId: id,
      };
      const buyPO  = buyAd.placeOrder(false, buyParams); 
      const sellParams: PlaceOrderParams = {
        type: OrderTypes.MARKET,
        side: OrderSides.SELL,
        symbol:sellExSymInfo.orderKey,
        quantity:targetQty,
        orderId: id,
      };
      const sellPO = sellAd.placeOrder(false, sellParams);
      // Promises sofort starten (parallel), aber Fehler in op() abfangen
      const [buyR, sellR] = await Promise.allSettled([buyPO, sellPO]);
      
      //=======================================================================
      // 3) exchange antwort auswerten
      //=======================================================================
      const buyOk  = isFulfilled(buyR) // promise result
        && buyR.value.status === 'FILLED';       // order result
      const sellOk = isFulfilled(sellR) // promise result
        && sellR.value.status === 'FILLED';      // order result
      if (buyOk && sellOk) {
        log.debug({
            id,
            symbol,
            buyEx,
            sellEx,
            buyQ               : buyR.value.cummulativeQuoteQty,
            buyP               : buyR.value.price,
            // buyCommission      : buyR.value.commission,
            // buyCommissionAsset : buyR.value.commissionAsset,
            sellQ              : sellR.value.cummulativeQuoteQty,
            sellP              : sellR.value.price,
            // sellCommission     : sellR.value.commission,
            // sellCommissionAsset: sellR.value.commissionAsset,
          },
          'orders executed'
        );
        // TODO: monitor fills / reconcile, invalidate balances snapshot
        const buyExQuoteKey = buyExSymInfo.quote; // USDC
        const buyExBaseKey = buyExSymInfo.base; // AXS
        let buyExBalanceQuote = state[buyEx]?.balances[buyExQuoteKey];
        let buyExBalanceBase = state[buyEx]?.balances[buyExBaseKey];
        if (!buyExBalanceQuote || !buyExBalanceBase) { // shoult not happen
          log.error({buyEx, buyExQuoteKey, buyExBaseKey}, 'invalid buy ex');
          return;
        }
        buyExBalanceQuote -= intent.q; // bought 350 AXS for 500 USDC
        buyExBalanceBase += targetQty; // bought 350 AXS for 500 USDC

        const sellExQuoteKey = sellExSymInfo.quote; // USDC
        const sellExBaseKey = sellExSymInfo.base; // AXS
        let sellExBalanceQuote = state[sellEx]?.balances[sellExQuoteKey];
        let sellExBalanceBase = state[sellEx]?.balances[sellExBaseKey];
        if (!sellExBalanceQuote || !sellExBalanceBase) { // shoult not happen
          log.error({buyEx, sellExQuoteKey, sellExBaseKey}, 'invalid sell ex');
          return;
        }
        sellExBalanceQuote += intent.q; // sold 350 AXS for 500 USDC
        sellExBalanceBase -= targetQty; // sold 350 AXS for 500 USDC
      
        bus.emit('trade:orders_ok', {
          id,
          ts: new Date().toISOString(),
          symbol,
          buyEx,
          buyQ               : buyR.value.cummulativeQuoteQty,
          buyP               : buyR.value.price,
          sellQ              : sellR.value.cummulativeQuoteQty,
          sellP              : sellR.value.price,
          sellEx
        });
      
      } else if (buyOk && !sellOk) {
        log.error({
          id,
          symbol,
          buyEx,
          sellEx,
          // sellErr: sellR.ok ? null : sellR.errObj,
          // sellRes: sellR.ok ? sellR.value : null,
        }, 'sell failed after buy placed');
        if (!CFG_AUTO_FIX_FAILED_ORDERS) { // nur wenn auch konfiguriert, versuchen zu reparieren
          return;
        }
        // Minimal: versuchen BUY zu canceln (wenn market sofort fillt, bringt cancel nichts, 
        // aber bei rejected/partial schon)
        const resCancelBuy = await safeCall(() => buyAd.cancelOrder({ 
          symbol: buyParams.symbol, origClientOrderId: buyParams.orderId }) );
        if (!resCancelBuy.ok) {
          log.warn({ intentId: id, buyEx, symbol, orderId: buyParams.orderId,
           }, 'cancel buy failed');
          // wenn buy auch nicht mehr gecancelt werden konnte, dann wieder verkaufen, da sonst die
          // bestaende weglaufen
          const resellParams : PlaceOrderParams = {
            symbol: buyParams.symbol,
            side: OrderSides.SELL,
            type: OrderTypes.MARKET,
            quantity: buyParams.quantity,
            orderId: `${buyParams.orderId}-RS`,
          }
          const resResell = await safeCall(() => buyAd.placeOrder(false, resellParams) );
          if (!resResell.ok) {
            log.warn({ intentId: id, buyEx, symbol, orderId: buyParams.orderId }, 'resell failed');
          }
        }
      } else if (!buyOk && sellOk) {
        log.error({
          id,
          symbol,
          buyEx,
          sellEx,
          // buyErr: buyR.ok ? null : buyR.errObj,
          // buyRes: buyR.ok ? buyR.value : null,
        }, 'buy failed after sell placed');
        if (!CFG_AUTO_FIX_FAILED_ORDERS) { // nur wenn auch konfiguriert, versuchen zu reparieren
          return;
        }
        // Minimal: versuchen SELL zu canceln (wenn market sofort fillt, bringt cancel nichts, 
        // aber bei rejected/partial schon)
        const resCancelSell = await safeCall(() => sellAd.cancelOrder({ 
          symbol: sellParams.symbol, origClientOrderId: sellParams.orderId }) );
        if (!resCancelSell.ok) {
          log.warn({ intentId: id, sellEx, symbol, orderId: sellParams.orderId }, 
            'cancel sell failed');

          // wenn sell auch nicht mehr gecancelt werden konnte, dann wieder kaufen, da sonst die
          // bestaende weglaufen
          const reBuyParams : PlaceOrderParams = {
            symbol: sellParams.symbol,
            side: OrderSides.BUY,
            type: OrderTypes.MARKET,
            quantity: sellParams.quantity,
            orderId: `${sellParams.orderId}-RB`,
          }
          const resRebuy = await safeCall(() => sellAd.placeOrder(false, reBuyParams) );
          if (!resRebuy.ok) {
            log.warn({ intentId: id, sellEx, symbol, orderId: sellParams.orderId, }, 
              'rebuy failed');
          }
        }
      } else { // beide failed
        log.warn({
            id,
            symbol,
            buyEx,
            sellEx,
            // buyErr: buyR.reason,
            // sellErr: sellR.reason,
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

  log.debug({ }, 'executor started');
  return { 
    state, 
    _state: state,      // optional (wenn du intern/Debug brauchst)
    _adapters: adapters, // optional (für Debug/Tests)
  };
}
