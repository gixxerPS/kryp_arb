const { suite, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBinanceDepthMessage,
  makeBinanceDepthHandler,
} = require('../../src/collector/parsers/binance_depth');

const symbolinfo = require('../../src/common/symbolinfo');

suite('collector/binance_depth', () => {
  const baseConfig = {
    symbolsCanon: ['MET_USDT'],
    exchangesCfg: { binance: { enabled: true, quote_map: { USDT: 'USDC' }, subscription:{levels:10, updateMs:100} } },
    symbolInfoByEx: {
      binance: {
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

  test('parseBinanceDepthMessage extrahiert bid/ask ', () => {
    const msg = {
      stream: 'metusdc@depth10@100ms',
      data: {
        bids: [
          ['0.27420000', '4193.0'],
          ['0.27410000', '12935.8'],
        ],
        asks: [
          ['0.27440000', '952.8'],
          ['0.27450000', '20491.0'],
        ],
      },
    };

    const out = parseBinanceDepthMessage(msg);
    assert.ok(out);

    assert.deepEqual(out.symbol, 'MET_USDT');
    assert.deepEqual(out.bids, [[0.2742, 4193.0],[0.2741, 12935.8]]);
    assert.deepEqual(out.asks, [[0.2744, 952.8],[0.2745, 20491.0]]);
  });

  test('makeBinanceDepthHandler emits md:l2', () => {
    const events = [];
    const handler = makeBinanceDepthHandler({
      exchange: 'binance',
      emit: (name, payload) => events.push({ name, payload }),
      nowMs: () => 123,
    });

    const ok = handler({
      stream: 'metusdc@depth10@100ms',
      data: { bids: [['1.0', '2.0']], asks: [['1.1', '3.0']] },
    });

    assert.equal(ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'md:l2');
    assert.equal(events[0].payload.exchange, 'binance');
    assert.equal(events[0].payload.symbol, 'MET_USDT');
    assert.equal(events[0].payload.tsMs, 123);
  });

});
