function fmt2(n) {
  return Number(n).toFixed(2);
}

function fmt4(n) {
  return Number(n).toFixed(4);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function symToBinance(sym) {
  // BTC_USDT -> btcusdt
  return sym.replace('_', '').toLowerCase();
}

function symToBitget(sym) {
  // BTC_USDT -> BTCUSDT
  return sym.replace('_', '');
}

function symToGate(sym) {
  // BTC_USDT -> BTC_USDT
  return sym;
}

function symFromExchange(sym) {
  // BTCUSDT -> BTC_USDT

  if (!sym) return sym;
  const s = sym.toUpperCase();

  // bereits kanonisch (BTC_USDT)
  if (s.includes('_')) return s;

  // BTCUSDT -> BTC_USDT
  if (s.endsWith('USDT')) {
    return s.slice(0, -4) + '_USDT';
  }

  // Fallback (für andere Quotes später)
  return s;
}

module.exports = {
  fmt2,
  fmt4,
  nowSec,
  symToBinance,
  symToBitget,
  symToGate,
  symFromExchange,
};

