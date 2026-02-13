'use strict';

const { getLogger } = require('../common/logger');
const log = getLogger('executor');
const { getExState } = require('../common/exchange_state');

const appBus = require('../bus');

const binanceAdapter = require('./adapter/binance_ws');

function assetsFromSymbols(symbols) {
  const s = new Set(['USDT']);
  for (const sym of symbols) {
    const [base, quote] = sym.split('_');
    if (base) s.add(base);
    if (quote) s.add(quote);
  }
  return [...s];
}

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
  const assetsWanted = assetsFromSymbols(enabledSymbols);

  const exStateArr = exState.getAllExchangeStates();
  
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
    // }
   };
   
  // startup balances
  for (const [ex, ad] of Object.entries(adapters)) {
    state[ex] = {
      balances : await ad.getStartupBalances(cfg )
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

  // später:
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
      // 1) prechecks BUY+SELL (gegen den aktuellen snapshot)
      // 2) place buy + sell (je nach späterer policy sequenziell/parallel)
      // 3) balances snapshot invalidieren/refresh triggern


      const { sym, buyEx, sellEx, targetQty } = intent;
      const buyAd = adapters[buyEx];
      const sellAd = adapters[sellEx];
      if (!buyAd || !sellAd) {
        log.warn({ reason:'adapter missing', intent, buyEx, sellEx }, 'dropping intent');
        return;
      }

      // 2) balance check (minimal)
      //    - buy side braucht quote (USDT)
      //    - sell side braucht base (z.B. BTC)
      //    -> hier später sauber mit fees, reserved, open orders etc.
      const [base, quote] = sym.split('_');
      const buyBal = state.balancesByEx[buyEx]?.[quote]?.free ?? 0;
      const sellBal = state.balancesByEx[sellEx]?.[base]?.free ?? 0;

      if (buyBal <= 0 || sellBal <= 0) return;

      // 3) orders schicken (minimal)
      //    - normalerweise: erst BUY, dann SELL oder parallel (je nach Modell)
      await buyAd.placeOrder({
        symbol: sym,
        side: 'BUY',
        type: 'MARKET',
        // qty/quoteQty je nach Ansatz
        targetQty,
        clientOrderId: intent.id,
      });

      await sellAd.placeOrder({
        symbol: sym,
        side: 'SELL',
        type: 'MARKET',
        targetQty,
        clientOrderId: intent.id,
      });

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
