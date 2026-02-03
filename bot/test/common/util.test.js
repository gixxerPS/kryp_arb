const { suite, test } = require('node:test');
const assert = require('node:assert/strict');

const { symFromExchange, symToBinance, symToBitget, feePctToFactor } = require('../../src/common/util');

suite('util', () => {
  test('symFromExchange normalisiert zu BASE_QUOTE (uppercase, underscore)', () => {
    assert.equal(symFromExchange('metusdt'), 'MET_USDT');
    assert.equal(symFromExchange('METUSDT'), 'MET_USDT');
    assert.equal(symFromExchange('met_usdt'), 'MET_USDT');
    assert.equal(symFromExchange('MET_USDT'), 'MET_USDT');
  });

  test('symToBinance entfernt underscore und lowercases', () => {
    assert.equal(symToBinance('MET_USDT'), 'metusdt');
  });

  test('symToBitget entfernt underscore und uppercases', () => {
    assert.equal(symToBitget('met_usdt'), 'METUSDT');
  });

});
