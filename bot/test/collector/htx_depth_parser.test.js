const { suite, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseHtxDepthMessage,
  makeHtxDepthHandler,
} = require('../../src/collector/parsers/htx_depth');

const symbolinfo = require('../../src/common/symbolinfo');

suite('collector/htx_depth', () => {
  const baseConfig = {
    symbolsCanon: ['MET_USDT'],
    exchangesCfg: { htx: { enabled: true, subscription: { levels: 20 } } },
    symbolInfoByEx: {
      htx: {
        symbols: {
          METUSDT: {
            symbol: 'METUSDT',
            baseAsset: 'MET',
            quoteAsset: 'USDT',
            status: 'online',
            enabled: true,
            qtyPrecision: 8,
            qtyStep: '0.01',
            minQty: 0.1,
            maxQty: 100,
            minNotional: 5,
            priceTick: '0.001',
          },
        },
      },
    },
  };

  function initSymbolinfo(cfg = baseConfig) {
    symbolinfo._resetForTests();
    symbolinfo.init(cfg);
  }

  beforeEach(() => {
    initSymbolinfo();
  });

  test('parseHtxDepthMessage extracts bids/asks from mbp.refresh channel', () => {
    const msg = {
      ch: 'market.metusdt.mbp.refresh.20',
      ts: 1710000000123,
      tick: {
        bids: [
          [0.2742, 4193.0],
          [0.2741, 12935.8],
        ],
        asks: [
          [0.2744, 952.8],
          [0.2745, 20491.0],
        ],
      },
    };

    const out = parseHtxDepthMessage(msg);
    assert.ok(out);

    assert.equal(out.symbol, 'MET_USDT');
    assert.deepEqual(out.bids, [[0.2742, 4193.0], [0.2741, 12935.8]]);
    assert.deepEqual(out.asks, [[0.2744, 952.8], [0.2745, 20491.0]]);
    assert.equal(out.tsMs, 1710000000123);
  });

  test('parseHtxDepthMessage returns null for invalid messages', () => {
    assert.equal(parseHtxDepthMessage({ ch: 'market.metusdt.trade.detail', tick: {} }), null);
    assert.equal(parseHtxDepthMessage({ ch: 'market.unknownusdt.mbp.refresh.20', tick: { bids: [[1, 1]], asks: [[2, 1]] } }), null);
    assert.equal(parseHtxDepthMessage({ ch: 'market.metusdt.mbp.refresh.20', tick: { bids: [], asks: [[2, 1]] } }), null);
  });

  test('makeHtxDepthHandler emits md:l2', () => {
    const events = [];

    const handler = makeHtxDepthHandler({
      exchange: 'htx',
      emit: (name, payload) => events.push({ name, payload }),
      nowMs: () => 123,
    });

    const ok = handler({
      ch: 'market.metusdt.mbp.refresh.20',
      tick: {
        bids: [[1.0, 2.0]],
        asks: [[1.1, 3.0]],
      },
    });

    assert.equal(ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'md:l2');
    assert.equal(events[0].payload.exchange, 'htx');
    assert.equal(events[0].payload.symbol, 'MET_USDT');
    assert.equal(events[0].payload.tsMs, 123);
  });
});
