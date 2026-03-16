const {suite, test} = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { default: startStrategy } = require('../../src/strategy'); 
const { EXCHANGE_QUALITY } = require('../../src/common/constants');

function mkCfg(overrides = {}) {
  return {
    bot: {
      execution_symbols: ['FOO_USDT'],
      cooldown_s: 10,
      throttle_ms: 200,
      ...overrides.bot,
    },
    symbols: ['FOO_USDT'],
    exchanges: {
      binance: { taker_fee_pct: 0.1 },
      bitget:  { taker_fee_pct: 0.1 },
      ...overrides.exchanges,
    },
  };
}

function initTestExchangeState() {
  return {
    getExchangeState: (exchange) => ({
      exchange,
      exchangeQuality: EXCHANGE_QUALITY.OK,
      anyAgeMs: 0,
    }),
  };
}

suite('strategy/index', () => {
  test('emits trade:intent for compute results and adds id/tsMs', () => {
    const bus = new EventEmitter();

    const emitted = [];
    bus.on('trade:intent', (m) => emitted.push(m));

    let now = 1_000_000;
    const nowFn = () => now;
    const uuidFn = () => 'uuid-1';

    const computeIntentsForSymbol = ({ sym }) => {
      return [ { symbol: sym, buyEx: 'binance', sellEx: 'bitget', q: 100, net2: 0.001, buyAsk: 100, sellBid: 101 } ]
    };

    const cfg = mkCfg({
      bot: { execution_symbols: ['FOO_USDT'], cooldown_s: 10, throttle_ms: 0 },
      symbols: ['FOO_USDT'],
    });

    startStrategy(cfg, { bus, computeIntentsForSymbol, nowFn, uuidFn, getExState: initTestExchangeState });

    bus.emit('md:l2', { exchange: 'binance', symbol: 'FOO_USDT', tsMs: now, bids: [], asks: [] });

    assert.deepEqual(emitted.length, 1);
    assert.deepEqual(emitted[0].id, 'uuid-1');
    assert.deepEqual(emitted[0].tsMs, now);
    assert.deepEqual(emitted[0].symbol, 'FOO_USDT');
    assert.deepEqual(emitted[0].buyEx, 'binance');
    assert.deepEqual(emitted[0].sellEx, 'bitget');
  });

  test('respects cooldown per routeKey (symbol|buy->sell)', () => {
    const bus = new EventEmitter();
    const emitted = [];
    bus.on('trade:intent', (m) => emitted.push(m));

    let now = 1_000_000;
    const nowFn = () => now;
    let uuidN = 0;
    const uuidFn = () => `uuid-${++uuidN}`;

    const computeIntentsForSymbol = ({ sym }) => ([
      { symbol: sym, buyEx: 'binance', sellEx: 'bitget', q: 100, net2: 0.001, buyAsk: 100, sellBid: 101 }
    ]);

    const cfg = mkCfg({
      bot: { execution_symbols: ['FOO_USDT'], cooldown_s: 10, throttle_ms: 0 },
      symbols: ['FOO_USDT'],
    });

    startStrategy(cfg, { bus, computeIntentsForSymbol, nowFn, uuidFn, getExState: initTestExchangeState });

    bus.emit('md:l2', { exchange: 'binance', symbol: 'FOO_USDT', tsMs: now, bids: [], asks: [] });
    assert.equal(emitted.length, 1);

    // innerhalb cooldown_s => kein zweiter Intent
    now += 9_000;
    bus.emit('md:l2', { exchange: 'bitget', symbol: 'FOO_USDT', tsMs: now, bids: [], asks: [] });
    assert.equal(emitted.length, 1);

    // nach cooldown_s => wieder erlaubt
    now += 2_000; // insgesamt 11s
    bus.emit('md:l2', { exchange: 'binance', symbol: 'FOO_USDT', tsMs: now, bids: [], asks: [] });
    assert.equal(emitted.length, 2);
  });

  test('respects throttle per symbol', () => {
    const bus = new EventEmitter();
    const emitted = [];
    bus.on('trade:intent', (m) => emitted.push(m));

    let now = 1_000_000;
    const nowFn = () => now;
    const uuidFn = () => 'uuid';

    let computeCalls = 0;
    const computeIntentsForSymbol = ({ sym }) => {
      computeCalls++;
      return [{ symbol: sym, buyEx: 'binance', sellEx: 'bitget', q: 100, net2: 0.001, buyAsk: 100, sellBid: 101 }];
    };

    const cfg = mkCfg({
      bot: { execution_symbols: ['FOO_USDT'], cooldown_s: 0, throttle_ms: 200 },
      symbols: ['FOO_USDT'],
    });

    startStrategy(cfg, { bus, computeIntentsForSymbol, nowFn, uuidFn, getExState: initTestExchangeState });

    bus.emit('md:l2', { exchange: 'binance', symbol: 'FOO_USDT', tsMs: now, bids: [], asks: [] });
    assert.equal(computeCalls, 1);

    // innerhalb throttle => compute nicht nochmal
    now += 100;
    bus.emit('md:l2', { exchange: 'bitget', symbol: 'FOO_USDT', tsMs: now, bids: [], asks: [] });
    assert.equal(computeCalls, 1);

    // nach throttle => compute wieder
    now += 200;
    bus.emit('md:l2', { exchange: 'binance', symbol: 'FOO_USDT', tsMs: now, bids: [], asks: [] });
    assert.equal(computeCalls, 2);
  });

  test('ignores md:l2 symbols not in cfg.symbols', () => {
    const bus = new EventEmitter();
    let computeCalls = 0;

    const computeIntentsForSymbol = () => { computeCalls++; return []; };

    const cfg = mkCfg({
      bot: { execution_symbols: ['FOO_USDT'], cooldown_s: 0, throttle_ms: 0 },
      symbols: ['FOO_USDT'],
    });

    startStrategy(cfg, { bus, computeIntentsForSymbol, nowFn: () => 1, uuidFn: () => 'u', getExState: initTestExchangeState });

    bus.emit('md:l2', { exchange: 'binance', symbol: 'BAR_USDT', tsMs: 1, bids: [], asks: [] });
    assert.equal(computeCalls, 0);
  });

});
