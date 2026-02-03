/**
 * WebSocket Reconnect-Strategie (praxisnah, bewusst konservativ)
 *
 * 1) Reconnect-Delay: Exponential Backoff + Jitter
 *    - Start schnell bei kurzen Glitches: baseDelayMs = 1s
 *    - Danach exponentiell: 1s → 2s → 4s → 8s → 16s → …
 *    - Gecappt bei maxDelayMs (typisch 30–60s)
 *    - Jitter (±20–30%), damit bei mehreren Connections
 *      kein synchroner Reconnect-Sturm entsteht
 *
 *    Motivation:
 *    - Einzelne Drops schnell abfangen
 *    - Bei echter Exchange-/Netz-Störung nicht aggressiv reconnecten
 *      (Rate-Limits, Policy Violations, Ban-Risiko)
 *
 * 2) Close-Handling
 *    - Clean shutdown (manuell): kein Reconnect
 *    - Fehler / Abbruch / terminate(): Reconnect mit Backoff
 *    - Bestimmte Fehler (z. B. 429, Policy Violation, Server Busy)
 *      können über delayOverrideMs() explizit längere Cooldowns erzwingen
 *
 * 3) Stale-Erkennung (wichtig!)
 *    - Zusätzlich zu WS close/error
 *    - lastMsgTs wird bei jeder Message / Pong aktualisiert
 *    - Wenn länger als staleTimeoutMs keine Daten kommen:
 *        → Connection gilt als „hängend“
 *        → ws.terminate() erzwingen
 *        → normaler Reconnect-Pfad greift
 *
 *    Hintergrund:
 *    - Ping/Pong allein ist nicht zuverlässig genug
 *    - Für Trading ist „keine Marktdaten“ gleichbedeutend mit „tot“
 *
 * 4) Reconnect-Recovery
 *    - Nach jedem erfolgreichen Reconnect:
 *        → Subscriptions neu senden
 *        → ggf. REST-Snapshot ziehen
 *        → Sequenzen / Checksums neu initialisieren
 *    - Backoff-Zähler wird erst bei erfolgreichem `open` zurückgesetzt
 *
 * 5) Multi-Collector-Schutz
 *    - Jitter verhindert gleichzeitige Reconnects vieler Streams
 *    - Optional: delayOverrideMs für Exchange-weite Cooldowns
 *
 * Ziel:
 *    Stabiler Betrieb unter schlechten Netzbedingungen,
 *    ohne unnötigen Load auf Exchange-APIs zu erzeugen.
 */

// src/collector/ws_reconnect.js

const { clamp, sleep, withJitter } = require('../common/util');

function createReconnectWS(opts) {
  const {
    name,
    connect,
    onOpen,
    onMessage,
    onLog,

    baseDelayMs = 1000,
    maxDelayMs = 30000,
    backoffFactor = 2,
    jitterPct = 0.3,

    staleTimeoutMs = 60000,

    delayOverrideMs,
  } = opts;

  let ws = null;
  let stopped = false;
  let attempt = 0;
  let lastMsgTs = 0;

  let staleTimer = null;

  async function cleanup() {
    if (staleTimer) clearInterval(staleTimer);
    staleTimer = null;

    if (ws) {
      try { ws.removeAllListeners?.(); } catch {}
      ws = null;
    }
  }

  function startTimers(currentWs) {
    lastMsgTs = Date.now();

    if (staleTimeoutMs > 0) {
      staleTimer = setInterval(() => {
        const age = Date.now() - lastMsgTs;
        if (age > staleTimeoutMs) {
          onLog({ name, ageMs: age, staleTimeoutMs }, 'ws stale; terminating');
          try { currentWs?.terminate?.(); }
          catch { try { currentWs?.close?.(); } catch {} }
        }
      }, clamp(Math.floor(staleTimeoutMs * 0.25), 1000, 5000));
    }
  }

  function computeDelayMs(ctx) {
    const overridden = delayOverrideMs?.(ctx);
    if (Number.isFinite(overridden)) {
      return Math.max(0, overridden | 0);
    }
    const raw = clamp(
      baseDelayMs * Math.pow(backoffFactor, attempt),
      baseDelayMs,
      maxDelayMs
    );
    return withJitter(raw, jitterPct);
  }

  async function loop() {
    while (!stopped) {
      try {
        ws = connect();
        if (!ws) throw new Error('connect() returned no ws');

        ws.on('open', async () => {
          if (stopped) return;
          attempt = 0;
          startTimers(ws);
          onLog({ name }, 'ws open');

          try {
            await onOpen(ws);
          } catch (err) {
            onLog({ name, err }, 'onOpen failed');
            try { ws.terminate?.(); } catch {}
          }
        });

        ws.on('message', (data) => {
          lastMsgTs = Date.now();
          try { onMessage?.(data, ws); }
          catch (err) {
            onLog({ name, err }, 'onMessage error');
          }
        });

        ws.on('pong', () => {
          lastMsgTs = Date.now();
        });
        const evt = await new Promise((resolve) => {
          ws.on('close', (code, reasonBuf) => {
            resolve({
              type: 'close',
              code,
              reason: reasonBuf?.toString?.() || '',
            });
          });
          ws.on('error', (err) => {
            resolve({ type: 'error', err });
          });
        });

        if (stopped) break;

        await cleanup();
        attempt += 1;
        const delayMs = computeDelayMs(evt);
        onLog(
          { name, attempt, delayMs, ...evt },
          'ws disconnected; reconnect scheduled'
        );
        await sleep(delayMs);
      } catch (err) {
        await cleanup();
        attempt += 1;
        const delayMs = computeDelayMs({ type: 'error', err });
        onLog(
          { name, attempt, delayMs, err },
          'ws loop error; reconnect scheduled'
        );
        await sleep(delayMs);
      }
    }
  }

  function start() {
    stopped = false;
    loop();
  }

  async function stop() {
    stopped = true;
    try { ws?.terminate?.(); } catch {}
    await cleanup();
    onLog({ name }, 'ws stopped');
  }
  return {
    start,
    stop,
    get ws() { return ws; },
  };
}

module.exports = { createReconnectWS };
