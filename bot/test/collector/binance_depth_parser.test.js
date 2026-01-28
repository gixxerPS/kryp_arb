const { suite, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBinanceDepthMessage,
  makeBinanceDepthHandler,
} = require('../../src/collector/parsers/binance_depth');

suite('collector/gate_depth', () => {

  test('parseBinanceDepthMessage extrahiert best bid/ask und l10 sums', () => {
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
    assert.equal(out.bestBid, 0.2742);
    assert.equal(out.bestAsk, 0.2744);
    assert.equal(out.bidQtyL1, 4193.0);
    assert.equal(out.askQtyL1, 952.8);
    assert.equal(out.bidQtyL10, 4193.0 + 12935.8);
    assert.equal(out.askQtyL10, 952.8 + 20491.0);
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
