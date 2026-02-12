'use strict';
const { suite, test } = require('node:test');
const assert = require('node:assert/strict');

const { marketOrderPrecheckOk } = require('../../src/executor/order_precheck');

suite('executor/order_precheck', () => {

  function mkSI(overrides = {}) {
    return {
      enabled: true,
      pricePrecision: 8,
      qtyPrecision: 8,
      priceTick: 0.001,
      qtyStep: "0.01000000",
      minQty: 0.1,
      maxQty: 100,
      minNotional: 5,
      ...overrides,
    };
  }

  //===========================================================================
  // check exchange requirements
  //===========================================================================

  test('NOK: symbol disabled', () => {
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'BUY',
      q: 5,
      symbolInfo: mkSI({enabled:false}),
      state: { binance: {balances: { USDC: 100 }}},
      feeRate: 0.001,
    });

    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'EX_SYMBOL_DISABLED');
  });
  test('NOK: exchange disabled', () => {
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'BUY',
      q: 50,
      symbolInfo: mkSI(),
      state: { binance: {enabled:false, balances: { USDC: 100 }}},
      feeRate: 0.001,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'EX_EXCHANGE_DISABLED');
  });
  test('NOK: q below min', () => {
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'SELL',
      q: 100,
      targetQty: 0.01,
      symbolInfo: mkSI(),
      state: { binance: {enabled:true, balances: { USDC: 100, AXS:100 }}},
      feeRate: 0.001,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'EX_MIN_QTY');
  });
  test('NOK: q above max', () => {
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'SELL',
      q: 100,
      targetQty: 1e9,
      symbolInfo: mkSI(),
      state: { binance: {enabled:true, balances: { USDC: 100, AXS:100 }}},
      feeRate: 0.001,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'EX_MAX_QTY');
  });
  test('NOK: below min notional', () => {
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'SELL',
      q: 1.47,
      targetQty: 1,
      symbolInfo: mkSI(),
      state: { binance: {enabled:true, balances: { USDC: 100, AXS:100 }}},
      feeRate: 0.001,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'EX_MIN_NOTIONAL');
  });
  test('NOK: EX_MIN_NOTIONAL after rounding reduces notional below min', () => {
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'SELL',
      q: 1.47,
      targetQty: 10.09, // => floor() = 10
      symbolInfo: mkSI({
        qtyPrecision : 1, // => 0.1 raster (=1e-1)
        minQty : 10.1
      }), 
      state: { binance: {enabled:true, balances: { USDC: 100, AXS:100 }}},
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
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'BUY',
      q: 20,
      targetQty: 10,
      symbolInfo: mkSI(), 
      state: { binance: {enabled:true, balances: { USDC: 100, AXS:100 }}},
      balance_minimum_usdt: 100,
      feeRate: 0.000,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'INT_INSUFFICIENT_BALANCE_USDT');
  });
  test('NOK:BUY fails INT_INSUFFICIENT_BALANCE_USDT incl fee', () => {
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'BUY',
      q: 20,
      targetQty: 10,
      symbolInfo: mkSI(), 
      state: { binance: {enabled:true, balances: { USDC: 120, AXS:100 }}},
      balance_minimum_usdt: 100,
      feeRate: 0.001, // fees make it fail < minimum
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'INT_INSUFFICIENT_BALANCE_USDT');
  });
  test('NOK: SELL fails INT_INSUFFICIENT_BALANCE_BASE', () => {
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'SELL',
      q: 20,
      targetQty: 10,
      symbolInfo: mkSI(), 
      state: { binance: {enabled:true, balances: { USDC: 150, AXS:9 }}},
      balance_minimum_usdt: 100,
      feeRate: 0.00, 
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reason, 'INT_INSUFFICIENT_BALANCE_BASE');
  });
  test('OK: BUY', () => {
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'BUY',
      q: 20,
      targetQty: 10,
      symbolInfo: mkSI(), 
      state: { binance: {enabled:true, balances: { USDC: 1000, AXS:1000 }}},
      balance_minimum_usdt: 100,
      feeRate: 0.00, 
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reason, null);
    assert.deepEqual(r.fixedTargetQtyStr, '10.00');
  });
  test('OK: SELL', () => {
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'SELL',
      q: 20,
      targetQty: 10,
      symbolInfo: mkSI(), 
      state: { binance: {enabled:true, balances: { USDC: 1000, AXS:1000 }}},
      balance_minimum_usdt: 100,
      feeRate: 0.00, 
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reason, null);
    assert.deepEqual(r.fixedTargetQtyStr, '10.00');
  });
  test('OK: fixedTargetQty when precision is not derived => use qtyStep', () => {
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'BUY',
      q: 20,
      targetQty: 10.123456,
      symbolInfo: mkSI(), 
      state: { binance: {enabled:true, balances: { USDC: 1000, AXS:1000 }}},
      balance_minimum_usdt: 100,
      feeRate: 0.00, 
    });
    assert.deepEqual(r.reason, null);
    assert.equal(r.ok, true);
    assert.deepEqual(r.fixedTargetQtyStr, '10.12');
  });
  test('OK: fixedTargetQty when precision is derived => use qtyPrecision', () => {
    const r = marketOrderPrecheckOk({
      exchange: 'binance',
      symbol: 'AXS_USDC',
      side: 'BUY',
      q: 20,
      targetQty: 10.123456,
      symbolInfo: mkSI({qtyStepDerivedFromPrecision:true,qtyPrecision: 4}), 
      state: { binance: {enabled:true, balances: { USDC: 1000, AXS:1000 }}},
      balance_minimum_usdt: 100,
      feeRate: 0.00, 
    });
    assert.deepEqual(r.reason, null);
    assert.equal(r.ok, true);
    assert.deepEqual(r.fixedTargetQtyStr, '10.1234');
  });

 
});
