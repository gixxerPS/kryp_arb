const { suite, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBinanceDepthMessage,
  makeBinanceDepthHandler,
} = require('../../src/collector/parsers/binance_depth');

suite('collector/binance_depth', () => {

  test('parseBinanceDepthMessage extrahiert bid/ask ', () => {
    const msg = {
      stream: 'metusdt@depth10@100ms',
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

    assert.equal(out.symbol, 'MET_USDT');
    assert.equal(out.bids, msg.data.bids);
    assert.equal(out.asks, msg.data.asks);
  });

  test('makeBinanceDepthHandler emits md:l2', () => {
    const events = [];

    const handler = makeBinanceDepthHandler({
      exchange: 'binance',
      emit: (name, payload) => events.push({ name, payload }),
      nowMs: () => 123,
    });

    const ok = handler({
      stream: 'metusdt@depth10@100ms',
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
