const { suite, test } = require('node:test');
const assert = require('node:assert/strict');

const { computeIntentsForSymV2, initStrategyEngine } = require('../../src/strategy/engine');
const { EXCHANGE_QUALITY } = require('../../src/common/constants');
const symbolinfo = require('../../src/common/symbolinfo');

const V2_ASKS = [
  [0.03357, 3194],
  [0.03358, 1156766],
  [0.03359, 15467],
  [0.0336, 1118031],
  [0.03361, 16108],
  [0.03362, 2208],
  [0.03363, 9964],
  [0.03364, 2160],
  [0.03365, 17691],
  [0.03366, 46205],
];

const V2_BIDS = [
  [0.03364, 5556.4],
  [0.03363, 14710.6],
  [0.03362, 14713],
  [0.03358, 56012.4],
  [0.03354, 2006.9],
  [0.03353, 27527.44],
  [0.03352, 51186],
  [0.03351, 22427.6],
  [0.0335, 44359.92],
  [0.03349, 19622.3],
];

const exState = {
  getExchangeState: (ex) => ({ exchange: ex, exchangeQuality: EXCHANGE_QUALITY.OK, anyAgeMs: 0 }),
};

function orderKeyFor(ex, sym) {
  if (ex === 'binance' || ex === 'bitget') return String(sym).replace('_', '').toUpperCase();
  if (ex === 'gate') return String(sym).toUpperCase();
  return String(sym);
}

function setupEngineRuntime({ sym, cfg, fees }) {
  const exchanges = cfg?.enabledExchanges ?? [];
  const exchangesCfg = {};
  const symbolInfoByEx = {};

  for (const ex of exchanges) {
    exchangesCfg[ex] = {
      enabled: true,
      subscription: { levels: 10, updateMs: 100 },
      taker_fee_pct: Number(fees?.[ex]?.taker_fee_pct ?? 0),
    };
    const orderKey = orderKeyFor(ex, sym);
    symbolInfoByEx[ex] = {
      symbols: {
        [orderKey]: { enabled: true },
      },
    };
  }

  symbolinfo._resetForTests();
  symbolinfo.init({
    symbolsCanon: [sym],
    exchangesCfg,
    symbolInfoByEx,
    log: { warn: () => {} },
  });
  initStrategyEngine(cfg);
}

function computeIntentsForSymV2WithInit(args) {
  setupEngineRuntime({ sym: args.sym, cfg: args.cfg, fees: args.fees });
  return computeIntentsForSymV2(args);
}

function assertApproxEqual(actual, expected, epsilon = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

suite('strategy/engineV2', () => {
  test('uses provided V2 orderbook fixture', () => {
    const nowMs = 1_000_000;
    const sym = 'TST_USDT';
    const latest = new Map();

    latest.set(`binance|${sym}`, {
      tsMs: nowMs,
      asks: V2_ASKS,
      bids: [
        [0.03356, 1000],
        [0.03355, 1000],
      ],
    });
    latest.set(`gate|${sym}`, {
      tsMs: nowMs,
      bids: V2_BIDS,
      asks: [
        [0.03365, 1000],
        [0.03366, 1000],
      ],
    });

    const cfg = {
      bot: {
        raw_spread_buffer_pct: 0,
        slippage_pct: 0.05,
        q_min_usdt: 1,
        q_max_usdt: 5000,
      },
      enabledExchanges: ['binance', 'gate'],
    };

    const fees = {
      binance: { taker_fee_pct: 0 },
      gate: { taker_fee_pct: 0 },
    };

    const intents = computeIntentsForSymV2WithInit({ sym, latest, fees, nowMs, cfg, exState });

    assert.equal(intents.length, 1);
    assert.equal(intents[0].buyEx, 'binance');
    assert.equal(intents[0].sellEx, 'gate');
    assert.equal(intents[0].buyAsk, 0.03357);
    assert.equal(intents[0].sellBid, 0.03364);
    assert.equal(intents[0].targetQty, 34980);
    assert.equal(intents[0].buyPxWorst, 0.03358);
    assert.equal(intents[0].sellPxWorst, 0.03362);
    assertApproxEqual(intents[0].qBuy, 1174.59646);
    assertApproxEqual(intents[0].qSell, 1176.285834);
    assertApproxEqual(intents[0].buyPxEff, 0.03357908690680389);
    assertApproxEqual(intents[0].sellPxEff, 0.03362738233276158);
    assertApproxEqual(intents[0].expectedPnl, 1.6893740000000435);
    assertApproxEqual(intents[0].net, 0.0011911852293031082);
  });

  test('drops intents when net after slippage is below configured minimum', () => {
    const nowMs = 1_000_000;
    const sym = 'TST_USDT';
    const latest = new Map();

    latest.set(`binance|${sym}`, {
      tsMs: nowMs,
      asks: [
        [100.00, 10],
        [100.01, 10],
      ],
      bids: [
        [99.99, 10],
        [99.98, 10],
      ],
    });
    latest.set(`gate|${sym}`, {
      tsMs: nowMs,
      bids: [
        [100.12, 10],
        [100.11, 10],
      ],
      asks: [
        [100.13, 10],
        [100.14, 10],
      ],
    });

    const cfg = {
      bot: {
        raw_spread_buffer_pct: 0,
        net_min_after_slippage_pct: 0.15,
        slippage_pct: 0.05,
        q_min_usdt: 1,
        q_max_usdt: 5000,
      },
      enabledExchanges: ['binance', 'gate'],
    };

    const fees = {
      binance: { taker_fee_pct: 0 },
      gate: { taker_fee_pct: 0 },
    };

    const intents = computeIntentsForSymV2WithInit({ sym, latest, fees, nowMs, cfg, exState });

    assert.equal(intents.length, 0);
  });
});
