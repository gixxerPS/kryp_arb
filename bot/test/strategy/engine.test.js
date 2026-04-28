const { suite, test } = require('node:test');
const assert = require('node:assert/strict');

const {  
  initStrategyEngine,
getQFromQtyL2 } = require('../../src/strategy/engine');
const { EXCHANGE_QUALITY } = require('../../src/common/constants');
const symbolinfo = require('../../src/common/symbolinfo');

const cfg = { 
  bot : {
    raw_spread_buffer_pct: 0.05,
    slippage_pct: 0.05,
    q_min_usdt: 100,
    q_max_usdt: 5000,
  }
};

const fees = {
  gate: { taker_fee_pct: 0.1 },
  binance: { taker_fee_pct: 0.1 },
};

const exState = {
  getExchangeState: (ex) => ({ exchange: ex, exchangeQuality: EXCHANGE_QUALITY.OK, anyAgeMs: 0 })
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


suite('strategy/engine stage 3. determine target qBuy, qSell for targetQty', () => {
  test('qty for exact level match', () => {
    const asks = [
      [100.00, 1],   // in band
      [100.05, 2],   // in band for 0.10%
      [100.20, 10],  // out of band
    ];
    const q = getQFromQtyL2({
      levels: asks,
      targetQty: 3,
    });
    assert.equal(q, 100*1 + 100.05*2);
  });

 
});
