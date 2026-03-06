import { getLogger } from '../common/logger';
const log = getLogger('executor');
import { getExState } from '../common/exchange_state';
import { getEx } from '../common/symbolinfo';
import { getExchange, getBotCfg } from '../common/config';
import { safeCall, isFulfilled } from '../common/async';
import { DAY_MS } from '../common/util';
import { marketOrderPrecheckOk } from './order_precheck';

import appBus from '../bus';
import { adapter as binanceAdapter } from './adapter/binance_ws';
import { adapter as gateAdapter } from './adapter/gate_ws';

import type { AppConfig } from '../types/config';
import type { ExchangeId } from '../types/common';
import { OrderTypes, OrderSides, ExchangeIds } from '../types/common';
import {
  type ExecutorAdapter,
  type PlaceOrderParams,
  type ExecutorDayStats,
  type ExecutorRuntimeState,
  type UpdateRuntimeStateParams,
  type ExecutorHandle,
  type ExecutorBalancesByExchange,
  type ExecutorAccountStatusByExchange,
  OrderStates
} from '../types/executor';
import type { TradeOrdersOkEvent, TradeWarnPrecheckEvent } from '../types/events';
import type { TradeIntent } from '../types/strategy';

type StartExecutorParams = {
  cfg: AppConfig;
  restoredRuntimeState?: ExecutorRuntimeState | null;
};

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
  { cfg, restoredRuntimeState }: StartExecutorParams,
  deps: Deps = {}
): Promise<ExecutorHandle> {
  const bus = deps.bus ?? appBus;
  const exState = deps.exState ?? getExState();
  const adaptersFromDeps = deps.adapters;
  const nowFn = deps.nowFn ?? (() => Date.now());

  // const enabledSymbols = getEnabledSymbols(cfg);

  const exStateArr = exState.getAllExchangeStates();

  const CFG_AUTO_FIX_FAILED_ORDERS = getBotCfg().auto_fix_failed_orders;
  let startupMaxTrades = 10; // kuenstliche bremse fuer trades

  // adapters ermitteln fuer exchanges die bei start enabled sind
  const adapters: Partial<Record<ExchangeId, ExecutorAdapter>> = deps.adapters ?? {};
  for (const ex of exStateArr) {
    if (!ex.enabled) {
      continue;
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

  const initialBalances: ExecutorBalancesByExchange = {};
  for (const [ex, ad] of Object.entries(adapters)) {
    initialBalances[ex as ExchangeId] = ad.getBalances();
  }
  log.debug({ initialBalances }, 'initialized');

  function isValidDayStats(v: any): boolean {
    return (
      !!v
      && typeof v.tsMs === 'number'
      && typeof v.pnlSum === 'number'
      && typeof v.successCount === 'number'
      && typeof v.failedCount === 'number'
      && Number.isFinite(v.tsMs)
      && Number.isFinite(v.pnlSum)
      && Number.isFinite(v.successCount)
      && Number.isFinite(v.failedCount)
    );
  }

  function makeDefaultRuntimeState(): ExecutorRuntimeState {
    return {
      today: { tsMs: nowFn(), pnlSum: 0, successCount: 0, failedCount: 0 },
      yesterday: { tsMs: 0, pnlSum: 0, successCount: 0, failedCount: 0 },
    };
  }

  const runtimeState: ExecutorRuntimeState = (
    restoredRuntimeState
    && isValidDayStats(restoredRuntimeState.today)
    && isValidDayStats(restoredRuntimeState.yesterday)
  )
    ? {
      today: { ...restoredRuntimeState.today },
      yesterday: { ...restoredRuntimeState.yesterday },
    }
    : makeDefaultRuntimeState();

  function updateRuntimeState(params: UpdateRuntimeStateParams): void {
    const tsMs = nowFn();

    // rollen noetig weil 1 tag vergangen ?
    if (tsMs - runtimeState.today.tsMs > DAY_MS) {
      runtimeState.yesterday = runtimeState.today;
      runtimeState.today = { tsMs, pnlSum: 0, successCount: 0, failedCount: 0 };
    }
    if (params.buyOk && params.sellOk) {
      runtimeState.today.successCount += 1;
      runtimeState.today.pnlSum += Number(params.pnl ?? 0);
      return;
    }
    runtimeState.today.failedCount += 1;
  }

  function getBalances(): ExecutorBalancesByExchange {
    const out: ExecutorBalancesByExchange = {};
    for (const [ex, ad] of Object.entries(adapters)) {
      out[ex as ExchangeId] = ad.getBalances();
    }
    return out;
  }

  function getRuntimeState(): ExecutorRuntimeState {
    return {
      today: { ...runtimeState.today },
      yesterday: { ...runtimeState.yesterday },
    };
  }

  function getAccountStatus(): ExecutorAccountStatusByExchange {
    const out: ExecutorAccountStatusByExchange = {};
    for (const [ex, ad] of Object.entries(adapters)) {
      out[ex as ExchangeId] = {
        ws: ad.isReady() ? 'OPEN' : 'CLOSED',
        totalBalance: 0,
      };
    }
    return out;
  }

  // TEST FUNKTIONIEEEERT :)
  // if (adapters.binance) {
  //   await adapters.binance.placeOrder(false, {
  //     symbol: 'AXSUSDC',
  //     side: 'BUY',
  //     type: 'MARKET',
  //     // qty/quoteQty je nach Ansatz
  //     quantity:10,
  //     orderId: '123456789',
  //   });
  // }
  // if (adapters.gate) {
  //   const gateSym = getEx('AXS_USDT', ExchangeIds.gate);
  //   if (!gateSym?.orderKey) {
  //     log.warn({ symbol: 'AXS_USDT', exchange: ExchangeIds.gate }, 'skip gate test order: missing orderKey');
  //   } else {
  //     const buyPO  = adapters.gate.placeOrder(false, {
  //       symbol: gateSym.orderKey,
  //       side: OrderSides.BUY,
  //       type: OrderTypes.MARKET,
  //       // qty/quoteQty je nach Ansatz
  //       quantity:10,
  //       q: 13.6,
  //       orderId: '123456789',
  //     }); 
  //     // Promises sofort starten (parallel), aber Fehler in op() abfangen
  //     const [buyR] = await Promise.allSettled([buyPO]);
      
  //     const buyOk  = isFulfilled(buyR) // promise result
  //       && buyR.value.status === OrderStates.FILLED;       // order result
  //     if (buyOk) {
  //       log.debug({rValue:buyR.value}, 'ORDER EXECUTED');
//         [2026-02-26 16:47:32.554 +0100] DEBUG (executor): placeOrder raw response
//     exchange: "gate"
//     reqParam: {
//       "currency_pair": "AXS_USDT",
//       "side": "buy",
//       "type": "market",
//       "text": "t-123456789",
//       "action_mode": "FULL",
//       "time_in_force": "fok",
//       "amount": "13.6"
//     }
//     rawOrderResponse: {
//       "id": "1021226213356",
//       "text": "t-123456789",
//       "amend_text": "-",
//       "create_time": "1772120852",
//       "update_time": "1772120852",
//       "create_time_ms": 1772120852424,
//       "update_time_ms": 1772120852424,
//       "status": "closed",
//       "currency_pair": "AXS_USDT",
//       "type": "market",
//       "account": "spot",
//       "side": "buy",
//       "amount": "13.6",
//       "price": "0",
//       "time_in_force": "fok",
//       "iceberg": "0",
//       "left": "0.00642",
//       "filled_amount": "10.01",
//       "fill_price": "13.59358",
//       "filled_total": "13.59358",
//       "avg_deal_price": "1.358",
//       "fee": "0",
//       "fee_currency": "AXS",
//       "point_fee": "0",
//       "gt_fee": "0.00173044158415841584",
//       "gt_maker_fee": "0",
//       "gt_taker_fee": "0.0009",
//       "gt_discount": true,
//       "rebated_fee": "0",
//       "rebated_fee_currency": "USDT",
//       "finish_as": "filled"
//     }
// [2026-02-26 16:47:32.555 +0100] DEBUG (executor): ORDER EXECUTED
//     rValue: {
//       "exchange": "gate",
//       "symbol": "AXS_USDT",
//       "status": "FILLED",
//       "orderId": "1021226213356",
//       "clientOrderId": "123456789",
//       "transactTime": 1772120852424,
//       "executedQty": 10.01,
//       "cummulativeQuoteQty": 13.59358,
//       "priceVwap": 1.358,
//       "slippage": null,
//       "fee_amount": 0.0017304415841584157,
//       "fee_currency": "AXS",
//       "fee_usd": 0.012234222
//     }

  //     } else {
  //       log.error({rStatus:buyR.status}, 'ORDER NOT EXECUTED');
  //     }
  //   }
  // }

  // spaeter:
  // for (const [ex, ad] of Object.entries(adapters)) {
  //   await ad.subscribeUserData((evt) => onUserEvent(ex, evt));
  // }

  let busy = false;

  async function handleIntent(intent: TradeIntent) {
    if (busy) {
      log.warn({ reason:'executor busy', intent }, 'dropping intent');
      return;
    }
    busy = true;
    try {
      const { symbol, buyEx, sellEx, targetQty, qBuy, qSell, id } = intent; // sym ist canonical
      const buyAd = adapters[buyEx];
      const sellAd = adapters[sellEx];
      if (!buyAd || !sellAd) {
        log.error({ reason:'adapter missing', intent, buyEx, sellEx }, 'dropping intent');
        return;
      }
      if (!buyAd.isReady() || !sellAd.isReady()) {
        log.error({ reason:'adapter not ready (ws not open / not logged in)', intent, buyEx, sellEx, buyAdReady:buyAd.isReady(), sellAdReady: sellAd.isReady() }, 'dropping intent');
        return;
      }
      const buyExSymInfo = getEx(symbol, buyEx);
      const sellExSymInfo = getEx(symbol, sellEx);
      if (!buyExSymInfo || !sellExSymInfo) {
        log.error({ reason:'symbolinfo missing', symbol, buyEx, sellEx }, 'dropping intent');
        return;
      }

      if (runtimeState.today.failedCount >= startupMaxTrades
        || runtimeState.today.successCount >= startupMaxTrades) {
        log.warn({ reason:'startup trade limit today reached', intent, STARTUP_MAX_TRADES: startupMaxTrades }, 'dropping intent');
        return;
      }
      const buyExchangeState = exState.getExchangeState(buyEx);
      const sellExchangeState = exState.getExchangeState(sellEx);
      const buyBalances = buyAd.getBalances();
      const sellBalances = sellAd.getBalances();
      
      //=======================================================================
      // 1.1) prechecks BUY (gegen den aktuellen bestands snapshot)
      //=======================================================================
      const resBuyCheck = marketOrderPrecheckOk({
        side: OrderSides.BUY,
        targetQty,
        q: qBuy,
        prepSymbolInfo: buyExSymInfo,
        exState:  { enabled: buyExchangeState?.enabled ?? true, balances: buyBalances },
        balance_minimum_usdt: cfg.bot.balance_minimum_usdt,
        feeRate: getExchange(buyEx).taker_fee_pct*0.01, // @TODO: kann optimiert werden da faktor 1/100 statisch
      });
      if (!resBuyCheck.ok) {
        log.warn({ reason:'precheck buy order failed', intent, buyEx, checkReason:resBuyCheck.reason },
          'dropping intent');
        const warnPrecheckEvent: TradeWarnPrecheckEvent = {
          ts: new Date(),
          symbol,
          side: 'BUY',
          exchange: buyEx,
          checkReason: String(resBuyCheck.reason ?? 'unknown'),
          checkReasonDesc: resBuyCheck.reasonDesc,
          intentId: id,
        };
        bus.emit('trade:warn_precheck', warnPrecheckEvent);
        return;
      }
      //=======================================================================
      // 1.2) prechecks SELL (gegen den aktuellen bestands snapshot)
      //=======================================================================
      const resSellCheck = marketOrderPrecheckOk({
        side: OrderSides.SELL,
        targetQty,
        q: qSell,
        prepSymbolInfo: sellExSymInfo,
        exState:  { enabled: sellExchangeState?.enabled ?? true, balances: sellBalances },
        balance_minimum_usdt: cfg.bot.balance_minimum_usdt,
        feeRate: getExchange(sellEx).taker_fee_pct*0.01, // @TODO: kann optimiert werden da faktor 1/100 statisch
      });
      if (!resSellCheck.ok) {
        log.warn({ reason:'precheck sell order failed', intent, sellEx, checkReason:resSellCheck.reason },
          'dropping intent');
        const warnPrecheckEvent: TradeWarnPrecheckEvent = {
          ts: new Date(),
          symbol,
          side: 'SELL',
          exchange: sellEx,
          checkReason: String(resSellCheck.reason ?? 'unknown'),
          checkReasonDesc: resSellCheck.reasonDesc,
          intentId: id,
        };
        bus.emit('trade:warn_precheck', warnPrecheckEvent);
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
        q: qBuy,
        orderId: id,
      };
      const buyPO  = buyAd.placeOrder(false, buyParams); 
      const sellParams: PlaceOrderParams = {
        type: OrderTypes.MARKET,
        side: OrderSides.SELL,
        symbol:sellExSymInfo.orderKey,
        quantity:targetQty,
        q: qSell,
        orderId: id,
      };
      const sellPO = sellAd.placeOrder(false, sellParams);
      // Promises sofort starten (parallel), aber Fehler in op() abfangen
      const [buyR, sellR] = await Promise.allSettled([buyPO, sellPO]);
      
      //=======================================================================
      // 3) exchange antwort auswerten
      //=======================================================================
      const buyOk  = isFulfilled(buyR) // promise result
        && buyR.value.status === OrderStates.FILLED;       // order result
      const sellOk = isFulfilled(sellR) // promise result
        && sellR.value.status === OrderStates.FILLED;      // order result
      const pnl = (buyOk && sellOk)
        ? sellR.value.cummulativeQuoteQty - buyR.value.cummulativeQuoteQty - buyR.value.fee_usd - sellR.value.fee_usd
        : 0.0;
      updateRuntimeState({ buyOk, sellOk, pnl });
      if (buyOk) {
        buyAd.updateBalancesFromOrderData({
          side: OrderSides.BUY,
          baseAsset: buyExSymInfo.base,
          quoteAsset: buyExSymInfo.quote,
          executedQty: buyR.value.executedQty ?? targetQty,
          cummulativeQuoteQty: buyR.value.cummulativeQuoteQty,
        });
      }
      if (sellOk) {
        sellAd.updateBalancesFromOrderData({
          side: OrderSides.SELL,
          baseAsset: sellExSymInfo.base,
          quoteAsset: sellExSymInfo.quote,
          executedQty: sellR.value.executedQty ?? targetQty,
          cummulativeQuoteQty: sellR.value.cummulativeQuoteQty,
        });
      }
      if (buyOk && sellOk) {
        log.debug({
            id,
            symbol,
            buyEx,
            sellEx,
            PnL: pnl,
            buyQ               : buyR.value.cummulativeQuoteQty,
            buyP               : buyR.value.priceVwap,
            buyFeeUsd          : buyR.value.fee_usd,
            sellQ              : sellR.value.cummulativeQuoteQty,
            sellP              : sellR.value.priceVwap,
            sellFeeUsd         : sellR.value.fee_usd,
          },
          'orders executed'
        );
      
        const ordersOkEvent: TradeOrdersOkEvent = {
          id, // intent_id
          ts: new Date(),
          symbol,
          buy: buyR.value,
          sell: sellR.value,
        };

        bus.emit('trade:orders_ok', ordersOkEvent);
      
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
          symbol: buyParams.symbol, orderId: buyParams.orderId }) );
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
          symbol: sellParams.symbol, orderId: sellParams.orderId }) );
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

  function setMoreTradeCount(n : number) {
    startupMaxTrades += Math.floor(n);
  }

  // subscription
  bus.on('trade:intent', (intent :TradeIntent) => {
    // als erstes state aktualisieren: ist exchange noch enabled? oder von 
    // ui (telegram / webserver) disabled worden?
    if (process.env.NODE_ENV !== 'production') {
      log.debug({ nodeEnv: process.env.NODE_ENV, intentId: intent.id }, 'skip handleIntent outside production');
      return;
    }
    handleIntent(intent).catch((err) => {
      log.error({ err, intent }, 'executor intent failed');
    });
  });

  log.debug({ }, 'executor started');
  return {
    getBalances,
    getAccountStatus,
    getRuntimeState,
    setMoreTradeCount,
  };
}
