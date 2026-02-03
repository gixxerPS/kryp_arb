
// formattierung in ausgaben
// bsp: log.debug(`net=${f(net)} buy=${f(buyPx, 2)} sell=${f(sellPx, 2)}`);
function f(n, d = 4) {
  return Number.isFinite(n) ? n.toFixed(d) : 'NaN';
}



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

function toNumLevels(levels) {
  const out = new Array(levels.length);
  for (let i = 0; i < levels.length; i++) {
    out[i] = [Number(levels[i][0]), Number(levels[i][1])];
  }
  return out;
}

function tradeRouteKey({ symbol, buyEx, sellEx }) {
  // beispiele:
  // BTC_USDT|binance->bitget
  // ETH_USDT|gate->binance
  return `${symbol}|${buyEx}->${sellEx}`;
}


function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function withJitter(ms, jitterPct = 0) {
  const j = clamp(jitterPct, 0, 1);
  const r = (1 - j) + Math.random() * (2 * j); // [1-j, 1+j]
  return Math.max(0, Math.round(ms * r));
}


module.exports = {
  symFromExchange,
  symToBinance,
  symToBitget,
  symToGate,
  nowSec,
  toNumLevels,
  tradeRouteKey,
  f,
  clamp,
  sleep,
  withJitter,
};

