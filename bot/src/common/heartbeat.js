// src/common/heartbeat.js
'use strict';

function createHeartbeat({ log, exchange, intervalMs = 10_000, staleAfterMs = 30_000 }) {
  const perSymbol = new Map(); // symbol -> { lastTsMs, lastSeenAt, count, lastLagMs }
  let total = 0;
  let lastAnyAt = 0;

  function onMessage({ symbol, tsMs }) {
    const now = Date.now();
    total += 1;
    lastAnyAt = now;

    const prev = perSymbol.get(symbol) || { count: 0, lastTsMs: 0, lastSeenAt: 0, lastLagMs: null };
    const lagMs = typeof tsMs === 'number' ? (now - tsMs) : null;

    perSymbol.set(symbol, {
      count: prev.count + 1,
      lastTsMs: tsMs ?? prev.lastTsMs,
      lastSeenAt: now,
      lastLagMs: lagMs,
    });
  }

  function topByMostStale(n = 6) {
    const now = Date.now();
    const arr = [];
    for (const [symbol, s] of perSymbol.entries()) {
      const ageMs = s.lastSeenAt ? (now - s.lastSeenAt) : Number.POSITIVE_INFINITY;
      arr.push({ symbol, ageMs, lastLagMs: s.lastLagMs, count: s.count, lastTsMs: s.lastTsMs });
    }
    arr.sort((a, b) => b.ageMs - a.ageMs);
    return arr.slice(0, n);
  }

  const timer = setInterval(() => {
    const now = Date.now();
    const ageAnyMs = lastAnyAt ? (now - lastAnyAt) : null;

    // globale Summary
    const uniqueSymbols = perSymbol.size;
    const staleSymbols = (() => {
      let c = 0;
      for (const s of perSymbol.values()) {
        if (s.lastSeenAt && (now - s.lastSeenAt) > staleAfterMs) c++;
      }
      return c;
    })();

    log.info(
      {
        exchange,
        hb: {
          intervalMs,
          staleAfterMs,
          totalMsgs: total,
          uniqueSymbols,
          ageAnyMs,
          staleSymbols,
          mostStale: topByMostStale(6),
        },
      },
      'collector heartbeat'
    );
  }, intervalMs);

  // damit process clean beenden kann
  if (timer.unref) timer.unref();

  return { onMessage, stop: () => clearInterval(timer) };
}

module.exports = { createHeartbeat };

