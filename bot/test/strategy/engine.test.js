const { suite, test } = require('node:test');
const assert = require('node:assert/strict');

const { computeIntents } = require('../../src/strategy/engine');

const cfg = { 
  bot : {
    min_raw_spread_pct: 0.30,
    slippage_pct: 0.05,
    q_min_usdt: 100,
    q_max_usdt: 5000,
  }
};

const fees = {
  gate: { taker_fee_pct: 0.1 },
  binance: { taker_fee_pct: 0.1 },
};


suite('strategy/engine', () => {
  test('computeIntents erzeugt intent wenn net edge > 0 und genug l10 liquidität', () => {
    const latest = new Map();
    const nowMs = 1_000_000;

    // buy on gate: ask=100, askQtyL10=100 => qMaxBuy=10k
    latest.set('gate|AAA_USDT', {
      tsMs: nowMs,
      bestAsk: 100,
      askQtyL10: 100,
    });

    // sell on binance: bid=100.6 => raw = 0.6%
    // bidQtyL10=100 => qMaxSell=10,060
    latest.set('binance|AAA_USDT', {
      tsMs: nowMs,
      bestBid: 100.6,
      bidQtyL10: 100,
    });

    cfg.bot.symbols = ['AAA_USDT'];
    cfg.bot.exchanges = ['gate', 'binance'];

    const intents = computeIntents({
      latest,
      fees,
      nowMs,
      cfg,
    });

    assert.equal(intents.length, 1);
    assert.equal(intents[0].buyEx, 'gate');
    assert.equal(intents[0].sellEx, 'binance');
    assert.ok(intents[0].qUsdt <= 5000);
    assert.ok(intents[0].edgeNet > 0);
  });

  test('computeIntents erzeugt keinen intent wenn stale', () => {
    const latest = new Map();
    const nowMs = 1_000_000;

    latest.set('gate|AAA_USDT', {
      tsMs: nowMs - 5000,
      bestAsk: 100,
      askQtyL10: 100,
    });

    latest.set('binance|AAA_USDT', {
      tsMs: nowMs,
      bestBid: 101,
      bidQtyL10: 100,
    });

    cfg.bot.symbols = ['AAA_USDT'];
    cfg.bot.exchanges = ['gate', 'binance'];

    const intents = computeIntents({
      latest,
      fees,
      nowMs,
      cfg,
    });

    assert.equal(intents.length, 0);
  });
});
