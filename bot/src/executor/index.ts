import { getLogger } from '../common/logger';
const log = getLogger('executor');
import { getExState } from '../common/exchange_state';
import { getEx } from '../common/symbolinfo';
import { getExchange, getBotCfg } from '../common/config';
import { safeCall, isFulfilled } from '../common/async';
import { DAY_MS } from '../common/util';
import { floorQuantityQToBalance, marketOrderPrecheckOk } from './order_precheck';

import appBus from '../bus';
import { adapter as binanceAdapter } from './adapter/binance_ws';
import { adapter as gateAdapter } from './adapter/gate_ws';
import { adapter as bitgetAdapter } from './adapter/bitget_ws';
import { adapter as mexcAdapter } from './adapter/mexc_ws';
import { adapter as htxAdapter } from './adapter/htx_ws';

import type { AppConfig } from '../types/config';
import type { ExchangeId } from '../types/common';
import { OrderTypes, OrderSides, ExchangeIds } from '../types/common';
import {
  type CommonOrderResult,
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
  restoredRuntimeState: ExecutorRuntimeState | null;
};

type Deps = {
  bus?: any;
  exState?: any;
  adapters?: Partial<Record<ExchangeId, ExecutorAdapter>>;
  nowFn?: () => number;
  enableIntentHandling?: boolean;
};

type PendingExecution = {
  intent: TradeIntent;
  createdAtTsMs: number;
  tmr?: NodeJS.Timeout;
  buy?: CommonOrderResult;
  sell?: CommonOrderResult;
  reservations: PendingReservation[];
};

type PendingReservation = {
  exchange: ExchangeId;
  asset: string;
  amount: number;
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
  let enableIntentHandling = deps.enableIntentHandling ?? (process.env.NODE_ENV === 'production');

  // const enabledSymbols = getEnabledSymbols(cfg);

  const exStateArr = exState.getAllExchangeStates();

  const CFG_AUTO_FIX_FAILED_ORDERS = getBotCfg().auto_fix_failed_orders;

  // adapters ermitteln fuer exchanges die bei start enabled sind
  const adapters: Partial<Record<ExchangeId, ExecutorAdapter>> = deps.adapters ?? {};
  for (const ex of exStateArr) {
    if (!ex.enabled) {
      continue;
    }
    if (ex.exchange === ExchangeIds.binance) {
      adapters.binance = binanceAdapter;
      await adapters.binance.init(cfg, {bus});
    } else if (ex.exchange === ExchangeIds.bitget) {
      adapters.bitget = bitgetAdapter;
      await adapters.bitget.init(cfg, {bus});
    } else if (ex.exchange === ExchangeIds.gate) {
      adapters.gate = gateAdapter;
      await adapters.gate.init(cfg, {bus});
    } else if (ex.exchange === ExchangeIds.mexc) {
      adapters.mexc = mexcAdapter;
      await adapters.mexc.init(cfg, {bus});
    } else if (ex.exchange === ExchangeIds.htx) {
      adapters.htx = htxAdapter;
      await adapters.htx.init(cfg, {bus});
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
      blockedRoutes: {},
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
      blockedRoutes: restoredRuntimeState.blockedRoutes
        ? restoredRuntimeState.blockedRoutes
        : {},
    }
    : makeDefaultRuntimeState();

  runtimeState.blockedRoutes = runtimeState.blockedRoutes ?? {};
  const blockedRoutes = runtimeState.blockedRoutes;
  const pendingExecutions = new Map<string, PendingExecution>();
  const reservedBalances: Partial<Record<ExchangeId, Record<string, number>>> = {};
  const PENDING_EXECUTION_TIMEOUT_MS = 30_000;
  const enabledExecutionSymbols = new Set(cfg.bot.execution_symbols ?? []);
  const restrictExecutionSymbols = enabledExecutionSymbols.size > 0;

  function updateRuntimeState(params: UpdateRuntimeStateParams): void {
    if (params.buyOk && params.sellOk) {
      runtimeState.today.successCount += 1;
      runtimeState.today.pnlSum += Number(params.pnl ?? 0);
      return;
    }
    runtimeState.today.failedCount += 1;
  }
  function rollRuntimeState() {
    const tsMs = nowFn();
    // rollen noetig weil 1 tag vergangen ?
    runtimeState.yesterday = runtimeState.today;
    runtimeState.today = { tsMs, pnlSum: 0, successCount: 0, failedCount: 0 };
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
      blockedRoutes,
    };
  }

  function clearPendingExecutionTimeout(pendingExecution?: PendingExecution): void {
    if (!pendingExecution?.tmr) return;
    clearTimeout(pendingExecution.tmr);
    pendingExecution.tmr = undefined;
  }

  function reserveBalance(exchange: ExchangeId, asset: string, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const byExchange = reservedBalances[exchange] ??= {};
    byExchange[asset] = (byExchange[asset] ?? 0) + amount;
  }

  function releaseBalance(exchange: ExchangeId, asset: string, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const byExchange = reservedBalances[exchange];
    if (!byExchange) return;
    const next = (byExchange[asset] ?? 0) - amount;
    if (next > 1e-9) {
      byExchange[asset] = next;
      return;
    }
    delete byExchange[asset];
    if (Object.keys(byExchange).length === 0) {
      delete reservedBalances[exchange];
    }
  }

  function releasePendingReservations(pendingExecution?: PendingExecution): void {
    for (const reservation of pendingExecution?.reservations ?? []) {
      releaseBalance(reservation.exchange, reservation.asset, reservation.amount);
    }
    if (pendingExecution) pendingExecution.reservations = [];
  }

  function getAvailableBalances(exchange: ExchangeId, balances: Record<string, number>): Record<string, number> {
    const reserved = reservedBalances[exchange];
    if (!reserved || Object.keys(reserved).length === 0) {
      return { ...balances };
    }
    const out = { ...balances };
    for (const [asset, amount] of Object.entries(reserved)) {
      out[asset] = Math.max(0, (out[asset] ?? 0) - amount);
    }
    return out;
  }

  function handleOrderResult(orderResult: CommonOrderResult): void {
    const intentId = orderResult.clientOrderId;
    // log.debug({size:pendingExecutions.size}, 'pending execution size @update start');
    if (!intentId) {
      log.warn({ orderResult }, 'skip order result without clientOrderId');
      return;
    }
    const pendingExecution = pendingExecutions.get(intentId);
    if (!pendingExecution) {
      log.warn({ intentId, orderResult }, 'pending execution missing for order result');
      return;
    }
    if (orderResult.exchange === pendingExecution.intent.buyEx) {
      pendingExecution.buy = orderResult;
    } else if (orderResult.exchange === pendingExecution.intent.sellEx) {
      pendingExecution.sell = orderResult;
    } else {
      log.warn({
        intentId,
        orderExchange: orderResult.exchange,
        buyEx: pendingExecution.intent.buyEx,
        sellEx: pendingExecution.intent.sellEx,
      }, 'order result exchange does not match pending execution');
      return;
    }
    log.debug({
      intentId,
      buyReceived: Boolean(pendingExecution.buy),
      sellReceived: Boolean(pendingExecution.sell),
      orderResult,
    }, 'pending execution updated');

    // wenn trade komplett, dann auswerten
    let pnl = 0.0;
    const buyR = pendingExecution.buy;
    const sellR = pendingExecution.sell;
    const buyOk = buyR?.status === OrderStates.FILLED;       // order result
    const sellOk = sellR?.status === OrderStates.FILLED;      // order result
    if (buyOk && sellOk) {
      let arbQty=0.0, deltaBalanceBase=0.0, buyFeeArb=0.0, sellFeeArb=0.0;
      // nur qty die auf beiden legs ausgefuehrt wurde in die pnl berechnung einbeziehen
      arbQty = Math.min(sellR.executedQty, buyR.executedQty);

      // anteilige fee berechnen der rest gehoert zu delta balance anteil
      if (buyR.executedQty > 0.0 && sellR.executedQty > 0.0) {
        buyFeeArb = arbQty / buyR.executedQty * buyR.fee_usd;
        sellFeeArb = arbQty / sellR.executedQty * sellR.fee_usd;
      }
      // bestand der sich aendert / driftet
      // +: mehr gekauft als verkauft => bestand wird aufgebaut
      // -: mehr verkauft als gekauft => bestand wird abgebaut
      deltaBalanceBase = buyR.executedQty - sellR.executedQty;
      pnl = (sellR.priceVwap  - buyR.priceVwap) * arbQty - buyFeeArb - sellFeeArb;
      
      log.debug({
          id: pendingExecution.intent.id,
          symbol: pendingExecution.intent.symbol,
          buyEx: pendingExecution.intent.buyEx,
          sellEx: pendingExecution.intent.sellEx,
          pnl,
          deltaBalanceBase,
          buyQ               : buyR.cummulativeQuoteQty,
          buyP               : buyR.priceVwap,
          buyFeeUsd          : buyR.fee_usd,
          sellQ              : sellR.cummulativeQuoteQty,
          sellP              : sellR.priceVwap,
          sellFeeUsd         : sellR.fee_usd,
        },
        'orders executed'
      );
      releasePendingReservations(pendingExecution);
      clearPendingExecutionTimeout(pendingExecution);
      pendingExecutions.delete(intentId); // aus der map entfernen
    
      // und app (z.b. datenbank) informieren
      const ordersOkEvent: TradeOrdersOkEvent = {
        id: intentId,
        ts: new Date(),
        symbol: pendingExecution.intent.symbol,
        buy: buyR,
        sell: sellR,
        pnl,
        deltaBalanceBase
      };
      bus.emit('trade:orders_ok', ordersOkEvent);
    }
    if (buyR && sellR) { // wenn trade komplett dann auswerten kann ok / failed sein
      updateRuntimeState({ buyOk, sellOk, pnl });
      busy = false;
    }
    
    // log.debug({size:pendingExecutions.size}, 'pending execution size @update end');
  }

  /**
   * Route sperren wenn kein balance da ist. Dann koennen wir eh nicht kaufen / verkaufen und brauchen gar nicht weiter pruefen
   * @param params 
   */
  function blockRoute(params: {
    symbol: string;
    exchange: ExchangeId;
    side: 'BUY' | 'SELL';
    asset: string;
  }): void {
    const { symbol, exchange, side, asset } = params;
    const bySymbol = blockedRoutes[symbol] ??= {};
    const byExchange = bySymbol[exchange] ??= {};
    const alreadyBlocked = Boolean(byExchange[side]);

    byExchange[side] = {
      blockedAtTsMs: nowFn(),
      exchange,
      asset,
    };
    log.debug({ symbol, exchange, side, asset, alreadyBlocked }, 'route blocked');
  }

  /**
   * Wenn balance auf einer exchange leer ist wird die route gesperrt, weil wir brauchen es ja gar nicht weiter versuchen.
   * Wenn die balances aber geupdated wurden muss geprueft werden ob die route wieder freigegeben werden kann.
   * Es koennte ja bestand durch rebalancing "extern" wieder draufgekommen sein.
   * @param params 
   * @returns 
   */
  function unblockRoutes(
    symbol: string,
    buyBalances: Record<string, number>,
    sellBalances: Record<string, number>,
  ): void {
    const buyUnblockHysteresisFactor = 1.1;
    const bySymbol = blockedRoutes[symbol];
    if (!bySymbol) return;

    for (const [exchange, sideMap] of Object.entries(bySymbol)) {
      if (!sideMap) continue;

      for (const [side, blockInfo] of Object.entries(sideMap)) {
        if (!blockInfo) continue;

        const balances = side === OrderSides.BUY ? buyBalances : sellBalances;
        const currentBalance = balances[blockInfo.asset] ?? 0;
        let requiredBalance = 0;
        if (side === OrderSides.BUY) {
          requiredBalance = cfg.bot.balance_minimum_usdt * buyUnblockHysteresisFactor;
        }
        if (currentBalance < requiredBalance) continue;
        log.debug({
          symbol,
          exchange,
          side,
          asset: blockInfo.asset,
          currentBalance,
          requiredBalance,
        }, 'route unblocked');
        delete bySymbol[exchange as ExchangeId]?.[side as 'BUY' | 'SELL'];
      }
      if (!Object.keys(sideMap).length) { // aufraeumen wenn moeglich
        delete bySymbol[exchange as ExchangeId];
      }
    }
    if (!Object.keys(bySymbol).length) { // aufraeumen wenn moeglich
      delete blockedRoutes[symbol];
    }
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
  // if (adapters.bitget) {
  //   await adapters.bitget.placeOrder({
  //     symbol: 'AXSUSDT',
  //     side: 'BUY',
  //     type: 'MARKET',
  //     // qty/quoteQty je nach Ansatz
  //     quantity:10,
  //     q:12,
  //     orderId: 'my-123456789',
  //   });
  // }


   // test intents fuer smoketest
  // setTimeout(() => {
  //   const now = Date.now();
  //   const intent: TradeIntent = {
  //     id: 'smoke-axs-101',
  //     tsMs: now,
  //     valid_until: new Date(now + 30_000),
  //     symbol: 'AXS_USDT',
      
  //     buyEx: ExchangeIds.htx,
  //     sellEx: ExchangeIds.mexc,
      
  //     targetQty: 10,
  //     net: 0.012,
  //     qBuy: 11.14,
  //     qSell: 11.24,
  //     buyPxEff: 1.114,
  //     sellPxEff: 1.124,
  //     expectedPnl: 0.10,
  //     buyAsk: 1.114,
  //     sellBid: 1.124,
  //     buyPxWorst: 1.114,
  //     sellPxWorst: 1.124,
  //   };
  //   log.debug({ intent }, 'trade:intent TEST');
  //   handleIntent(intent).catch((err) => {
  //     log.error({ err, intent }, 'executor TEST intent failed');
  //   });
  // }, 1_000);

  
  
  let busy = false;
  
  async function handleIntent(intent: TradeIntent) {
    if (busy) {
      log.warn({ reason:'executor busy', intent }, 'dropping intent');
      return;
    }
    busy = true;
    try {
      if (restrictExecutionSymbols && !enabledExecutionSymbols.has(intent.symbol)) {
        log.debug({ intentId: intent.id, symbol: intent.symbol }, 'dropping intent: symbol not enabled for execution');
        busy = false;
        return;
      }
      const { symbol, buyEx, sellEx, targetQty, qBuy, qSell, buyPxEff, sellPxEff, id } = intent; // sym ist canonical
      let orderTargetQty = targetQty;
      let orderQBuy = qBuy;
      let orderQSell = qSell;
      const buyAd = adapters[buyEx];
      const sellAd = adapters[sellEx];
      if (!buyAd || !sellAd) {
        log.error({ reason:'adapter missing', intent, buyEx, sellEx }, 'dropping intent');
        busy = false;
        return;
      }
      if (!buyAd.isReady() || !sellAd.isReady()) {
        log.error({ reason:'adapter not ready (ws not open / not logged in)', intent, buyEx, sellEx, buyAdReady:buyAd.isReady(), sellAdReady: sellAd.isReady() }, 'dropping intent');
        busy = false;
        return;
      }
      const buyExSymInfo = getEx(symbol, buyEx);
      const sellExSymInfo = getEx(symbol, sellEx);
      if (!buyExSymInfo || !sellExSymInfo) {
        log.error({ reason:'symbolinfo missing', symbol, buyEx, sellEx }, 'dropping intent');
        busy = false;
        return;
      }
      const buyExchangeState = exState.getExchangeState(buyEx);
      const sellExchangeState = exState.getExchangeState(sellEx);
      const buyBalances = getAvailableBalances(buyEx, buyAd.getBalances());
      const sellBalances = getAvailableBalances(sellEx, sellAd.getBalances());
      unblockRoutes(symbol, buyBalances, sellBalances); // pruefen ob wir ggf neue balances haben und sell|buy auf einer exchange wieder freigeben koennen
      const buyBlocked = blockedRoutes[symbol]?.[buyEx]?.[OrderSides.BUY];
      const sellBlocked = blockedRoutes[symbol]?.[sellEx]?.[OrderSides.SELL];
      if (buyBlocked || sellBlocked) {
        log.debug({ symbol, buyEx, sellEx, buyBlocked, sellBlocked }, 'dropping intent: route blocked due to insufficient balance');
        busy = false;
        return;
      }
      //=======================================================================
      // 1.1) prechecks BUY (gegen den aktuellen bestands snapshot)
      //=======================================================================
      const resBuyCheck = marketOrderPrecheckOk({
        side: OrderSides.BUY,
        targetQty: orderTargetQty,
        q: orderQBuy,
        prepSymbolInfo: buyExSymInfo,
        exState:  { enabled: buyExchangeState?.enabled ?? true, balances: buyBalances },
        balance_minimum_usdt: cfg.bot.balance_minimum_usdt,
      });
      if (!resBuyCheck.ok) {
        if (resBuyCheck.reason === 'INT_INSUFFICIENT_BALANCE_USDT') {
          const flooredBuy = floorQuantityQToBalance({
            intent: { targetQty: orderTargetQty, qBuy: orderQBuy, qSell: orderQSell, buyPxEff, sellPxEff },
            side: OrderSides.BUY,
            prepSymbolInfo: buyExSymInfo,
            exState: { enabled: buyExchangeState?.enabled ?? true, balances: buyBalances },
            balance_minimum_usdt: cfg.bot.balance_minimum_usdt,
          });
          log.debug({newParams:{flooredBuy}}, 'reduced quote due to insufficient balance');
          if (flooredBuy.ok) {
            orderTargetQty = flooredBuy.targetQty;
            orderQBuy = orderTargetQty * buyPxEff;
            orderQSell = orderTargetQty * sellPxEff;
          } else {
            blockRoute({
              symbol,
              exchange: buyEx,
              side: OrderSides.BUY,
              asset: buyExSymInfo.quote,
            });
            log.warn({ reason:'precheck buy order failed', intent, buyEx, checkReason:resBuyCheck.reason, floorReasonDesc:flooredBuy.reasonDesc },
              'dropping intent');
            const warnPrecheckEvent: TradeWarnPrecheckEvent = {
              ts: new Date(),
              symbol,
              side: 'BUY',
              exchange: buyEx,
              checkReason: String(resBuyCheck.reason ?? 'unknown'),
              checkReasonDesc: `${resBuyCheck.reasonDesc}; floorReason=${flooredBuy.reasonDesc}`,
              intentId: id,
            };
            bus.emit('trade:warn_precheck', warnPrecheckEvent);
            busy = false;
            return;
          }
        } else {
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
        busy = false;
        return;
        }
      }
      //=======================================================================
      // 1.2) prechecks SELL (gegen den aktuellen bestands snapshot)
      //=======================================================================
      const resSellCheck = marketOrderPrecheckOk({
        side: OrderSides.SELL,
        targetQty: orderTargetQty,
        q: orderQSell,
        prepSymbolInfo: sellExSymInfo,
        exState:  { enabled: sellExchangeState?.enabled ?? true, balances: sellBalances },
        balance_minimum_usdt: cfg.bot.balance_minimum_usdt,
      });
      if (!resSellCheck.ok) {
        if (resSellCheck.reason === 'INT_INSUFFICIENT_BALANCE_BASE') {
          const flooredSell = floorQuantityQToBalance({
            intent: { targetQty: orderTargetQty, qBuy: orderQBuy, qSell: orderQSell, buyPxEff, sellPxEff },
            side: OrderSides.SELL,
            prepSymbolInfo: sellExSymInfo,
            exState: { enabled: sellExchangeState?.enabled ?? true, balances: sellBalances },
            balance_minimum_usdt: cfg.bot.balance_minimum_usdt,
          });
          log.debug({newParams:{flooredSell}}, 'reduced quote due to insufficient balance');
          if (flooredSell.ok) {
            orderTargetQty = flooredSell.targetQty;
            orderQBuy = orderTargetQty * buyPxEff;
            orderQSell = orderTargetQty * sellPxEff;
          } else {
            blockRoute({
              symbol,
              exchange: sellEx,
              side: OrderSides.SELL,
              asset: sellExSymInfo.base,
            });
            log.warn({ reason:'precheck sell order failed', intent, sellEx, checkReason:resSellCheck.reason, floorReasonDesc:flooredSell.reasonDesc },
              'dropping intent');
            const warnPrecheckEvent: TradeWarnPrecheckEvent = {
              ts: new Date(),
              symbol,
              side: 'SELL',
              exchange: sellEx,
              checkReason: String(resSellCheck.reason ?? 'unknown'),
              checkReasonDesc: `${resSellCheck.reasonDesc}; floorReason=${flooredSell.reasonDesc}`,
              intentId: id,
            };
            bus.emit('trade:warn_precheck', warnPrecheckEvent);
            busy = false;
            return;
          }
        } else {
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
        busy = false;
        return;
        }
      }
      //=======================================================================
      // 2) orders schicken (parallel)
      //=======================================================================
      const pendingExecution: PendingExecution = {
        intent,
        createdAtTsMs: Date.now(),
        reservations: [],
      };
      const buyReservationAsset = buyExSymInfo.quote;
      const buyReservationAmount = orderQBuy;
      reserveBalance(buyEx, buyReservationAsset, buyReservationAmount);
      pendingExecution.reservations.push({
        exchange: buyEx,
        asset: buyReservationAsset,
        amount: buyReservationAmount,
      });
      const sellReservationAsset = sellExSymInfo.base;
      const sellReservationAmount = orderTargetQty;
      reserveBalance(sellEx, sellReservationAsset, sellReservationAmount);
      pendingExecution.reservations.push({
        exchange: sellEx,
        asset: sellReservationAsset,
        amount: sellReservationAmount,
      });
      pendingExecution.tmr = setTimeout(() => { // wir erwarten eine antwort auf beide orders innerhalb von 30s !!!
        const buyOk = Boolean(pendingExecution.buy);
        const sellOk = Boolean(pendingExecution.sell);
        const pnl = 0.0;
        log.warn({ intentId: id, symbol, buyEx, sellEx,
          buyReceived: buyOk,
          sellReceived: sellOk,
          }, 'pending execution expired');
        releasePendingReservations(pendingExecution);
        updateRuntimeState({ buyOk, sellOk, pnl });
        pendingExecutions.delete(id);
        busy = false;
      }, PENDING_EXECUTION_TIMEOUT_MS);
      pendingExecution.tmr.unref?.();
      pendingExecutions.set(id, pendingExecution); // erst in die map eintragen was wir vorhaben
      const buyParams: PlaceOrderParams = {
        type: OrderTypes.MARKET,
        side: OrderSides.BUY,
        symbol: buyExSymInfo.orderKey,
        quantity:orderTargetQty,
        q: orderQBuy,
        orderId: id,
      };
      buyAd.placeOrder(buyParams).catch((err) => {
        log.error({ err, intentId: id, exchange: buyEx, buyParams }, 'buy placeOrder failed');
      });
      const sellParams: PlaceOrderParams = {
        type: OrderTypes.MARKET,
        side: OrderSides.SELL,
        symbol:sellExSymInfo.orderKey,
        quantity:orderTargetQty,
        q: orderQSell,
        orderId: id,
      };
      sellAd.placeOrder(sellParams).catch((err) => {
        log.error({ err, intentId: id, exchange: sellEx, sellParams }, 'sell placeOrder failed');
      });
    } catch (err) {
      log.error({ err, intent }, 'handle intent failed');
      busy = false;
    }
  }

  // subscription
  bus.on('trade:intent', (intent :TradeIntent) => {
    // als erstes state aktualisieren: ist exchange noch enabled? oder von 
    // ui (telegram / webserver) disabled worden?
    if (!enableIntentHandling) {
      log.debug({ nodeEnv: process.env.NODE_ENV, intentId: intent.id }, 'skip handleIntent');
      return;
    }
    handleIntent(intent).catch((err) => {
      log.error({ err, intent }, 'executor intent failed');
    });
  });
  bus.on('trade:order_result', (result :CommonOrderResult) => {
    handleOrderResult(result);
  });

  // once a day ...
  let dayTmr: NodeJS.Timeout | null = null;
  if (process.env.NODE_ENV !== 'development' && !dayTmr) { // kein doppeltes Interval
    dayTmr = setInterval(() => {
      rollRuntimeState(); // ... switch today -> yesterday
    }, DAY_MS);
    dayTmr.unref?.();
  } 

  function enableOrderExecution() {
    enableIntentHandling = true;
  }
  function disableOrderExecution() {
    enableIntentHandling = false;
  }
  function getOrderExecutionState() {
    return enableIntentHandling;
  }

  log.debug({ }, 'executor started');
  return {
    getBalances,
    getAccountStatus,
    getRuntimeState,
    enableOrderExecution,
    disableOrderExecution,
    getOrderExecutionState
  };
}
