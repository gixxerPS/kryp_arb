const fs = require('fs');

// formattierung in ausgaben
// bsp: log.debug(`net=${f(net)} buy=${f(buyPx, 2)} sell=${f(sellPx, 2)}`);
function f(n, d = 4) {
  return Number.isFinite(n) ? n.toFixed(d) : 'NaN';
}

// 09.02.2026, 14:37:05
function fmtNowLocal() { 
  return new Date().toLocaleString('de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// 2026-02-09 14:37:05
function fmtNowIsoLocal() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * konvertiere canonical symbol zu exchange symbol fuer
 * market data subscription.
 * 
 * canonical symbols sind die in symbol.json und bot.json
 * 
 * aber auf binance z.b. nur USDC paare handelbar, deshalb muss
 * dort USDT auf USDC gemappt werden. entsprechend muss dann
 * marktdaten abo und order execution richtig abgesetzt werden (z.b. in AXS_USDC und nicht AXS_USDT)!!!
 */ 
// function canonToExSymMD(canonSym, ex, exCfg) {
//   const [base, quote] = String(canonSym).split('_');
//   const q2 = exCfg?.quote_map?.[quote] ?? quote;
//   const mapped = `${base}_${q2}`;

//   if (ex === 'binance') return symToBinance(mapped); // axsUSDC -> "axsusdc"
//   if (ex === 'bitget')  return symToBitget(mapped);  // "AXSUSDT"
//   if (ex === 'gate')    return symToGate(mapped);    // "axs_usdt"
//   return mapped;
// }

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

async function getPublicIp() {
  const res = await fetch('https://api.ipify.org');
  return (await res.text()).trim();
}

function readJson(fp) {
  const raw = fs.readFileSync(fp, 'utf8');
  return JSON.parse(raw);
}

module.exports = {
  nowSec,
  toNumLevels,
  tradeRouteKey,
  f,
  clamp,
  sleep,
  withJitter,
  fmtNowLocal,
  fmtNowIsoLocal,
  getPublicIp,
  // canonToExSymMD,
  readJson,
};

