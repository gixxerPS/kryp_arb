// bot/test/collector/bitget_depth.test.js
const {suite, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBitgetDepthMessage,
  makeBitgetDepthHandler,
} = require('../../src/collector/parsers/bitget_depth');

suite('collector/bitget_depth', () => {
  test('parseBitgetDepthMessage extrahiert best bid/ask und l10 sums', () => {
    const msg = {
      action: 'update',
      arg: {
        instType: 'SPOT',
        channel: 'books',
        instId: 'METUSDT',
      },
      data: [{
        ts: '1710000000123',
        bids: [
          ['0.2742', '4193.0'],
          ['0.2741', '12935.8'],
        ],
        asks: [
          ['0.2744', '952.8'],
          ['0.2745', '20491.0'],
        ],
      }],
    };

    const out = parseBitgetDepthMessage(msg);
    assert.ok(out);

    assert.equal(out.symbol, 'MET_USDT');
    assert.equal(out.bestBid, 0.2742);
    assert.equal(out.bestAsk, 0.2744);
    assert.equal(out.bidQtyL1, 4193.0);
    assert.equal(out.askQtyL1, 952.8);
    assert.equal(out.bidQtyL10, 4193.0 + 12935.8);
    assert.equal(out.askQtyL10, 952.8 + 20491.0);
    assert.equal(out.tsMs, 1710000000123);
  });

  test('parseBitgetDepthMessage returns null for non-books / non-update messages', () => {
    // wrong channel
    assert.equal(parseBitgetDepthMessage({
      action: 'update',
      arg: { channel: 'ticker', instId: 'METUSDT' },
      data: [{ ts: '1', bids: [['1', '1']], asks: [['2', '1']] }],
    }), null);

    // wrong action
    assert.equal(parseBitgetDepthMessage({
      action: 'subscribe',
      arg: { channel: 'books', instId: 'METUSDT' },
      data: [{ ts: '1', bids: [['1', '1']], asks: [['2', '1']] }],
    }), null);

    // missing data
    assert.equal(parseBitgetDepthMessage({
      action: 'update',
      arg: { channel: 'books', instId: 'METUSDT' },
      data: [],
    }), null);
  });

  test('makeBitgetDepthHandler emits md:l2', () => {
    const events = [];

    const handler = makeBitgetDepthHandler({
      exchange: 'bitget',
      emit: (name, payload) => events.push({ name, payload }),
      nowMs: () => 123,
    });

    const ok = handler({
      action: 'update',
      arg: {
        instType: 'SPOT',
        channel: 'books',
        instId: 'METUSDT',
      },
      data: [{
        // ts missing -> nowMs fallback
        bids: [['1.0', '2.0']],
        asks: [['1.1', '3.0']],
      }],
    });

    assert.equal(ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'md:l2');
    assert.equal(events[0].payload.exchange, 'bitget');
    assert.equal(events[0].payload.symbol, 'MET_USDT');
    assert.equal(events[0].payload.tsMs, 123);
  });
});
