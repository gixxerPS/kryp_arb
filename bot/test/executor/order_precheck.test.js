'use strict';
const { suite, test } = require('node:test');
const assert = require('node:assert/strict');

const { marketOrderPrecheckOk } = require('../../src/executor/order_precheck');

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
      feeRate: 0.001,
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
      feeRate: 0.001,
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
      feeRate: 0.001,
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
      feeRate: 0.001,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'EX_MAX_QTY');
  });
  test('NOK: below min notional', () => {
    initSymbolinfo();
    const r = marketOrderPrecheckOk({
      side: 'SELL',
      q: 1.47,
      targetQty: 1,
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState:  {enabled:true, balances: { USDC: 100, AXS: 100 }},
      feeRate: 0.001,
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
      feeRate: 0.001,
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
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState:  {enabled:true, balances: { USDC: 100, AXS: 100 }},
      balance_minimum_usdt: 100,
      feeRate: 0.000,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'INT_INSUFFICIENT_BALANCE_USDT');
  });
  test('NOK:BUY fails INT_INSUFFICIENT_BALANCE_USDT incl fee', () => {
    initSymbolinfo();
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'BUY',
      q: 20,
      targetQty: 10,
      prepSymbolInfo: symbolinfo.getEx('AXS_USDT','binance'),
      exState:  {enabled:true, balances: { USDC: 100, AXS: 100 }},
      balance_minimum_usdt: 100,
      feeRate: 0.001, // fees make it fail < minimum
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
});
