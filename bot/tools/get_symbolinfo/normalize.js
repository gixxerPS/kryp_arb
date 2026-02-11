function pow10Tick(decimals) {
  if (!Number.isFinite(decimals) || decimals < 0) return null;
  return 10 ** (-decimals);
}
  
  function asInt(x) {
    if (x === null || x === undefined || x === "") return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  
  function asNumber(x) {
    if (x === null || x === undefined || x === "") return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  module.exports = { pow10Tick, asInt, asNumber };
  