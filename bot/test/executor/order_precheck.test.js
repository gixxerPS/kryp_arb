'use strict';
const { suite, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  marketOrderPrecheckOk,
  floorQuantityQToBalance
} = require('../../src/executor/order_precheck');

const symbolinfo = require('../../src/common/symbolinfo');

suite('executor/order_precheck', () => {

  const baseConfig = {
    symbolsCanon: ['AXS_USDT'],
    exchangesCfg: { binance: { enabled: true, quote_map: { USDT: 'USDC' }, subscription:{levels:10, updateMs:100} } },
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
            taker_fee: 0.001
          }
        }
      }
    },
  }

  function initSymbolinfo(cfg = baseConfig) {
    symbolinfo._resetForTests();
    symbolinfo.init(cfg);
  }

  //===========================================================================
  // check exchange requirements
  //===========================================================================

  test('NOK: symbol disabled', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.symbolInfoByEx.binance.symbols.AXSUSDC.enabled = false;
    initSymbolinfo(cfg);
    const r = marketOrderPrecheckOk({
      side: 'BUY',
      targetQty:10,
      q: 5,
      prepSymbolInfo: symbolinfo.getSymbolInfo('AXS_USDT').binance,
      exState:  {enabled:true, balances: { USDC: 100, AXS: 100 }},
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'EX_SYMBOL_DISABLED');
  });
  test('NOK: exchange disabled', () => {
    initSymbolinfo();
    const r = marketOrderPrecheckOk({
      side: 'BUY',
      q: 50,
      prepSymbolInfo: symbolinfo.getSymbolInfo('AXS_USDT').binance,
      exState:  {enabled:false, balances: { USDC: 100, AXS: 100 }},
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'EX_EXCHANGE_DISABLED');
  });
  test('NOK: q below min', () => {
    initSymbolinfo();
    const r = marketOrderPrecheckOk({
      side: 'SELL',
      q: 100,
      targetQty: 0.01,
      prepSymbolInfo: symbolinfo.getSymbolInfo('AXS_USDT').binance, // minQty = 0.1
      exState:  {enabled:true, balances: { USDC: 100, AXS: 100 }},
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'EX_MIN_QTY');
  });
  test('NOK: q above max', () => {
    initSymbolinfo();
    const r = marketOrderPrecheckOk({
      side: 'SELL',
      q: 100,
      targetQty: 1e9,
      prepSymbolInfo: symbolinfo.getSymbolInfo('AXS_USDT').binance,
      exState:  {enabled:true, balances: { USDC: 100, AXS: 100 }},
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'EX_MAX_QTY');
  });
  test('OK: minQty null is treated as 0', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.symbolInfoByEx.binance.symbols.AXSUSDC.minQty = null;
    initSymbolinfo(cfg);
    const r = marketOrderPrecheckOk({
      side: 'SELL',
      q: 100,
      targetQty: 0.01,
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState:  {enabled:true, balances: { USDC: 100, AXS: 100 }},
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reason, null);
  });
  test('OK: maxQty null is treated as unlimited', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.symbolInfoByEx.binance.symbols.AXSUSDC.maxQty = null;
    initSymbolinfo(cfg);
    const r = marketOrderPrecheckOk({
      side: 'SELL',
      q: 100,
      targetQty: 1000,
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState:  {enabled:true, balances: { USDC: 100, AXS: 2000 }},
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reason, null);
  });
  test('NOK: below min notional', () => {
    initSymbolinfo();
    const r = marketOrderPrecheckOk({
      side: 'SELL',
      q: 1.47,
      targetQty: 1,
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState:  {enabled:true, balances: { USDC: 100, AXS: 100 }},
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'EX_MIN_NOTIONAL');
  });
  test('NOK: EX_MIN_NOTIONAL after rounding reduces notional below min', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.symbolInfoByEx.binance.symbols.AXSUSDC.qtyStep = 0.1;
    cfg.symbolInfoByEx.binance.symbols.AXSUSDC.minQty = 10.1;
    initSymbolinfo(cfg);
    const r = marketOrderPrecheckOk({
      side: 'SELL',
      q: 1.47,
      targetQty: 10.09, // => floor() = 10
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState:  {enabled:true, balances: { USDC: 100, AXS: 100 }},
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'EX_MIN_NOTIONAL');
    assert.deepEqual(r.fixedTargetQtyStr, '');
  });

  //===========================================================================
  // check our own requirements
  //===========================================================================

  test('NOK:BUY fails INT_INSUFFICIENT_BALANCE_USDT incl fee', () => {
    initSymbolinfo();
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'BUY',
      q: 20,
      targetQty: 10,
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'), // fees make it fail < minimum = 0.001
      exState:  {enabled:true, balances: { USDC: 100, AXS: 100 }},
      balance_minimum_usdt: 100,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'INT_INSUFFICIENT_BALANCE_USDT');
  });
  test('NOK: SELL fails INT_INSUFFICIENT_BALANCE_BASE', () => {
    initSymbolinfo();
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'SELL',
      q: 20,
      targetQty: 10,
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState:  {enabled:true, balances: { USDC: 150, AXS: 9 }},
      balance_minimum_usdt: 100,
      feeRate: 0.00, 
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'INT_INSUFFICIENT_BALANCE_BASE');
  });
  test('OK: BUY', () => {
    initSymbolinfo();
    const r = marketOrderPrecheckOk({
      side: 'BUY',
      q: 20,
      targetQty: 10,
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState:  {enabled:true, balances: { USDC: 1000, AXS: 1000 }},
      balance_minimum_usdt: 100,
      feeRate: 0.00, 
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reason, null);
    assert.deepEqual(r.fixedTargetQtyStr, '10.00');
  });
  test('OK: SELL', () => {
    initSymbolinfo();
    const r = marketOrderPrecheckOk({
      side: 'SELL',
      q: 20,
      targetQty: 10,
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState:  {enabled:true, balances: { USDC: 1000, AXS: 1000 }},
      balance_minimum_usdt: 100,
      feeRate: 0.00, 
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reason, null);
    assert.deepEqual(r.fixedTargetQtyStr, '10.00');
  });
  test('OK: fixedTargetQty when precision is not derived => use qtyStep', () => {
    initSymbolinfo();
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'BUY',
      q: 20,
      targetQty: 10.123456,
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'), // qtyStep: "0.01000000",
      exState:  {enabled:true, balances: { USDC: 1000, AXS: 1000 }},
      balance_minimum_usdt: 100,
      feeRate: 0.00, 
    });
    assert.deepEqual(r.reason, null);
    assert.equal(r.ok, true);
    assert.deepEqual(r.fixedTargetQtyStr, '10.12');
  });
  test('OK: fixedTargetQty when precision is derived => use qtyPrecision', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.symbolInfoByEx.binance.symbols.AXSUSDC.qtyStep = '0.0001';
    initSymbolinfo(cfg);
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'BUY',
      q: 20,
      targetQty: 10.123456,
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'), // qtyStep: "0.01000000",
      exState:  {enabled:true, balances: { USDC: 1000, AXS: 1000 }},
      balance_minimum_usdt: 100,
      feeRate: 0.00, 
    });
    assert.deepEqual(r.reason, null);
    assert.equal(r.ok, true);
    assert.deepEqual(r.fixedTargetQtyStr, '10.1234');
  });

  test('OK: floorQuantityQToBalance BUY floors qty to keep quote minimum', () => {
    initSymbolinfo();
    const r = floorQuantityQToBalance({
      intent: {
        targetQty: 10,
        qBuy: 20,
        qSell: 22,
        buyPxEff: 2,
        sellPxEff: 2.2,
      },
      side: 'BUY',
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState: { enabled: true, balances: { USDC: 115, AXS: 100 } },
      balance_minimum_usdt: 100,
    });
    assert.equal(r.ok, true);
    assert.equal(r.targetQty, 7.5);
    assert.equal(r.targetQtyStr, '7.50');
    assert.equal(r.q, 15);
  });

  test('OK: floorQuantityQToBalance SELL floors qty to available base', () => {
    initSymbolinfo();
    const r = floorQuantityQToBalance({
      intent: {
        targetQty: 10,
        qBuy: 20,
        qSell: 22,
        buyPxEff: 2,
        sellPxEff: 2.2,
      },
      side: 'SELL',
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState: { enabled: true, balances: { USDC: 1000, AXS: 6.789 } },
      balance_minimum_usdt: 100,
    });
    assert.equal(r.ok, true);
    assert.equal(r.targetQty, 6.78);
    assert.equal(r.targetQtyStr, '6.78');
    assert.ok(Math.abs(r.q - 6.78*2.2) < 1e-12);
  });

  test('NOK: floorQuantityQToBalance fails when floored qty violates exchange minQty', () => {
    initSymbolinfo();
    const r = floorQuantityQToBalance({
      intent: {
        targetQty: 10,
        qBuy: 20,
        qSell: 22,
        buyPxEff: 2,
        sellPxEff: 2.2,
      },
      side: 'BUY',
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState: { enabled: true, balances: { USDC: 100.1, AXS: 100 } },
      balance_minimum_usdt: 100,
    });
    assert.equal(r.ok, false);
    assert.match(r.reasonDesc, /minQty=0.1/);
  });

  test('NOK: floorQuantityQToBalance fails when minQty passes but minNotional stays below limit', () => {
    initSymbolinfo();
    const r = floorQuantityQToBalance({
      intent: {
        targetQty: 10,
        qBuy: 1,
        qSell: 1.1,
        buyPxEff: 0.1,
        sellPxEff: 0.11,
      },
      side: 'BUY',
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState: { enabled: true, balances: { USDC: 100.5, AXS: 100 } },
      balance_minimum_usdt: 100,
    });
    assert.equal(r.ok, false);
    assert.equal(r.targetQty, 5);
    assert.equal(r.targetQtyStr, '5.00');
    assert.equal(r.q, 0.5);
    assert.match(r.reasonDesc, /minNotional=5/);
  });
});
