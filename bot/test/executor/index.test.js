'use strict';
const { suite, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');

const config = require('../../src/common/config');
const symbolinfo = require('../../src/common/symbolinfo');
const { default: startExecutor } = require('../../src/executor');

suite('executor/index', () => {
  const originalGetExchange = config.getExchange;
  const originalGetBotCfg = config.getBotCfg;

  const symbolCfg = {
    symbolsCanon: ['AXS_USDT'],
    exchangesCfg: {
      binance: { enabled: true, quote_map: { USDT: 'USDC' }, subscription: { levels: 10, updateMs: 100 } },
      gate: { enabled: true, subscription: { levels: 10, updateMs: 100 } },
    },
    symbolInfoByEx: {
      binance: {
        symbols: {
          AXSUSDC: {
            symbol: 'AXSUSDC',
            baseAsset: 'AXS',
            quoteAsset: 'USDC',
            status: 'TRADING',
            enabled: true,
            qtyPrecision: 8,
            qtyStep: '0.01',
            minQty: 0.1,
            maxQty: 100,
            minNotional: 5,
            priceTick: '0.001',
          }
        }
      },
      gate: {
        symbols: {
          AXS_USDT: {
            symbol: 'AXS_USDT',
            baseAsset: 'AXS',
            quoteAsset: 'USDT',
            status: 'tradable',
            enabled: true,
            qtyPrecision: 8,
            qtyStep: '0.01',
            minQty: 0.1,
            maxQty: 100,
            minNotional: 5,
            priceTick: '0.001',
          }
        }
      }
    },
  };

  before(() => {
    config.getExchange = () => ({ taker_fee_pct: 0.1 });
    config.getBotCfg = () => ({ auto_fix_failed_orders: false });
    symbolinfo._resetForTests();
    symbolinfo.init(symbolCfg);
  });

  after(() => {
    config.getExchange = originalGetExchange;
    config.getBotCfg = originalGetBotCfg;
    symbolinfo._resetForTests();
  });

  function mkIntent(overrides = {}) {
    return {
      id: 'intent-1',
      tsMs: 1,
      valid_until: new Date('2026-03-12T00:00:05.000Z'),
      symbol: 'AXS_USDT',
      buyEx: 'binance',
      sellEx: 'gate',
      targetQty: 10,
      net: 0.01,
      qBuy: 20,
      qSell: 22,
      buyPxEff: 2,
      sellPxEff: 2.2,
      expectedPnl: 2,
      buyAsk: 2,
      sellBid: 2.2,
      buyPxWorst: 2,
      sellPxWorst: 2.2,
      ...overrides,
    };
  }

  test('floors insufficient buy balance and places both orders with reduced size', async () => {
    const bus = new EventEmitter();
    const placed = [];

    function mkAdapter(exchange, balances) {
      return {
        isReady: () => true,
        getBalances: () => balances,
        updateBalancesFromOrderData: () => {},
        placeOrder: async (params) => {
          placed.push({ exchange, params });
          const result = {
            exchange,
            symbol: params.symbol,
            side: params.side,
            status: 'FILLED',
            orderId: `${exchange}-1`,
            clientOrderId: String(params.orderId),
            transactTime: Date.now(),
            executedQty: params.quantity,
            cummulativeQuoteQty: params.q ?? 0,
            priceVwap: params.quantity > 0 ? (params.q ?? 0) / params.quantity : 0,
            fee_amount: 0,
            fee_currency: 'USDT',
            fee_usd: 0,
          };
          bus.emit('trade:order_result', result);
          return result;
        },
        cancelOrder: async () => {
          throw new Error('not used');
        },
      };
    }

    await startExecutor({
      cfg: {
        bot: {
          balance_minimum_usdt: 100,
        },
      },
    }, {
      bus,
      exState: {
        getAllExchangeStates: () => [],
        getExchangeState: () => ({ enabled: true }),
      },
      adapters: {
        binance: mkAdapter('binance', { USDC: 115, AXS: 100 }),
        gate: mkAdapter('gate', { USDT: 1000, AXS: 100 }),
      },
      nowFn: () => 1_700_000_000_000,
      enableIntentHandling: true,
    });

    const ordersOkPromise = once(bus, 'trade:orders_ok');
    bus.emit('trade:intent', mkIntent());
    await ordersOkPromise;

    assert.equal(placed.length, 2);
    assert.deepEqual(placed[0], {
      exchange: 'binance',
      params: {
        type: 'MARKET',
        side: 'BUY',
        symbol: 'AXSUSDC',
        quantity: 7.5,
        q: 15,
        orderId: 'intent-1',
      },
    });
    assert.deepEqual(placed[1], {
      exchange: 'gate',
      params: {
        type: 'MARKET',
        side: 'SELL',
        symbol: 'AXS_USDT',
        quantity: 7.5,
        q: 16.5,
        orderId: 'intent-1',
      },
    });
  });

  test('blocks route after insufficient buy balance and unblocks when cached balance recovers', async () => {
    const bus = new EventEmitter();
    const placed = [];
    const buyBalances = { USDC: 100.1, AXS: 100 };
    const sellBalances = { USDT: 1000, AXS: 100 };

    function mkAdapter(exchange, balances) {
      return {
        isReady: () => true,
        getBalances: () => balances,
        updateBalancesFromOrderData: () => {},
        placeOrder: async (params) => {
          placed.push({ exchange, params });
          const result = {
            exchange,
            symbol: params.symbol,
            side: params.side,
            status: 'FILLED',
            orderId: `${exchange}-1`,
            clientOrderId: String(params.orderId),
            transactTime: Date.now(),
            executedQty: params.quantity,
            cummulativeQuoteQty: params.q ?? 0,
            priceVwap: params.quantity > 0 ? (params.q ?? 0) / params.quantity : 0,
            fee_amount: 0,
            fee_currency: 'USDT',
            fee_usd: 0,
          };
          bus.emit('trade:order_result', result);
          return result;
        },
        cancelOrder: async () => {
          throw new Error('not used');
        },
      };
    }

    const executor = await startExecutor({
      cfg: {
        bot: {
          balance_minimum_usdt: 100,
        },
      },
    }, {
      bus,
      exState: {
        getAllExchangeStates: () => [],
        getExchangeState: () => ({ enabled: true }),
      },
      adapters: {
        binance: mkAdapter('binance', buyBalances),
        gate: mkAdapter('gate', sellBalances),
      },
      nowFn: () => 1_700_000_000_000,
      enableIntentHandling: true,
    });

    const warnPromise = once(bus, 'trade:warn_precheck');
    bus.emit('trade:intent', mkIntent());
    const [warnEvt] = await warnPromise;
    assert.equal(warnEvt.checkReason, 'INT_INSUFFICIENT_BALANCE_USDT');
    assert.equal(placed.length, 0);
    assert.deepEqual(executor.getRuntimeState().blockedRoutes, {
      AXS_USDT: {
        binance: {
          BUY: {
            blockedAtTsMs: 1_700_000_000_000,
            exchange: 'binance',
            asset: 'USDC',
          },
        },
      },
    });

    bus.emit('trade:intent', mkIntent({ id: 'intent-2' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(placed.length, 0);

    buyBalances.USDC = 130;

    const ordersOkPromise = once(bus, 'trade:orders_ok');
    bus.emit('trade:intent', mkIntent({ id: 'intent-3' }));
    await ordersOkPromise;
    assert.equal(placed.length, 2);
    assert.deepEqual(executor.getRuntimeState().blockedRoutes, {});
  });
});
