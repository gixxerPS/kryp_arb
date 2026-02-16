// bot/test/collector/gate_depth.test.js
const { suite, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseGateDepthMessage,
  makeGateDepthHandler,
} = require('../../src/collector/parsers/gate_depth');

const symbolinfo = require('../../src/common/symbolinfo');

suite('collector/gate_depth', () => {
  const baseConfig = {
    symbolsCanon: ['MET_USDT'],
    exchangesCfg: { gate: { enabled: true, subscription:{levels:10, updateMs:100} } },
    symbolInfoByEx: {
      gate: {
        symbols: {
          METUSDC: {
            symbol: 'METUSDC',
            baseAsset: 'MET',
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

  beforeEach(() => {
    initSymbolinfo();
  });

  test('parseGateDepthMessage extrahiert best bid/ask und l10 sums', () => {
    const msg = {
      time: 1710000000,
      channel: 'spot.order_book',
      event: 'update',
      result: {
        t: 1710000001,
        s: 'MET_USDT',
        bids: [
          ['0.2742', '4193.0'],
          ['0.2741', '12935.8'],
        ],
        asks: [
          ['0.2744', '952.8'],
          ['0.2745', '20491.0'],
        ],
      },
    };

    const out = parseGateDepthMessage(msg);
    assert.ok(out);

    assert.equal(out.symbol, 'MET_USDT');
    assert.deepEqual(out.bids, [[0.2742, 4193.0],[0.2741, 12935.8]]);
    assert.deepEqual(out.asks, [[0.2744, 952.8],[0.2745, 20491.0]]);
    assert.deepEqual(out.tsMs, 1710000001 * 1000);
  });

  test('parseGateDepthMessage returns null for non-update messages', () => {
    assert.equal(parseGateDepthMessage({ channel: 'spot.order_book', event: 'subscribe' }), null);
    assert.equal(parseGateDepthMessage({ channel: 'spot.ticker', event: 'update' }), null);
  });

  test('makeGateDepthHandler emits md:l2', () => {
    const events = [];

    const handler = makeGateDepthHandler({
      exchange: 'gate',
      emit: (name, payload) => events.push({ name, payload }),
      nowMs: () => 123,
    });

    const ok = handler({
      channel: 'spot.order_book',
      event: 'update',
      result: {
        s: 'MET_USDT',
        bids: [['1.0', '2.0']],
        asks: [['1.1', '3.0']],
      },
    });

    assert.equal(ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'md:l2');
    assert.equal(events[0].payload.exchange, 'gate');
    assert.equal(events[0].payload.symbol, 'MET_USDT');
    // r.t missing -> nowMs fallback
    assert.equal(events[0].payload.tsMs, 123);
  });
});
