function symFromExchange(sym) {
  if (!sym) return sym;
  const s = String(sym).toUpperCase();

  if (s.includes('_')) return s;

  if (s.endsWith('USDT')) {
    return s.slice(0, -4) + '_USDT';
  }

  return s;
}

function symToBinance(sym) {
  return String(sym).replace('_', '').toLowerCase();
}

function symToBitget(sym) {
  return String(sym).replace('_', '').toUpperCase();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function feePctToFactor(pct) {
  return Number(pct) / 100.0;
}

module.exports = {
  symFromExchange,
  symToBinance,
  symToBitget,
  nowSec,
  feePctToFactor,
};

