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

function symToGate(sym) {
  return String(sym).toLowerCase();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function feePctToFactor(pct) {
  return Number(pct) / 100.0;
}

function sumQty(levels, n) {
  let s = 0;
  const lim = Math.min(levels.length, n);
  for (let i = 0; i < lim; i += 1) {
    const q = Number(levels[i][1]);
    if (Number.isFinite(q)) s += q;
  }
  return s;
}

module.exports = {
  symFromExchange,
  symToBinance,
  symToBitget,
  symToGate,
  nowSec,
  feePctToFactor,
  sumQty
};

