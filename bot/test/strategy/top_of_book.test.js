const { suite, test } = require('node:test');
const assert = require('node:assert/strict');

const { bestBidPx, bestAskPx } = require('../../src/strategy/engine');

suite('strategy/top_of_book', () => {
  test('bestBidPx picks the maximum bid price (sorted desc)', () => {
    const bids = [['101', '1'], ['100', '2'], ['99', '3']];
    assert.equal(bestBidPx(bids), 101);
  });

  test('bestBidPx picks the maximum bid price (sorted asc / wrong)', () => {
    const bids = [['99', '3'], ['100', '2'], ['101', '1']];
    assert.equal(bestBidPx(bids), 101);
  });

  test('bestBidPx picks the maximum bid price (unsorted)', () => {
    const bids = [['100', '2'], ['101', '1'], ['99', '3']];
    assert.equal(bestBidPx(bids), 101);
  });

  test('bestAskPx picks the minimum ask price (sorted asc)', () => {
    const asks = [['102', '1'], ['103', '2'], ['104', '3']];
    assert.equal(bestAskPx(asks), 102);
  });

  test('bestAskPx picks the minimum ask price (sorted desc / wrong)', () => {
    const asks = [['104', '3'], ['103', '2'], ['102', '1']];
    assert.equal(bestAskPx(asks), 102);
  });
});
