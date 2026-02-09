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

/**
 * @param {object} opts
 * @param {string} opts.name - label for logs
 * @param {() => import('ws')} opts.connect - must create and return a new ws instance
 * @param {(ws: any) => (void|Promise<void>)} opts.onOpen - subscribe/resync logic
 * @param {(data: any, ws: any) => void} [opts.onMessage] - optional message hook
 * @param {(err: any) => void} opts.onLog - logger fn (e.g. (o,msg)=>log.info(o,msg))
 * @param {number} [opts.baseDelayMs=1000] initial reconnect delay after first disconnect.
//             Example: 1000ms => first retry happens quickly for transient drops.
 * @param {number} [opts.maxDelayMs=30000] upper bound for backoff delay.
//            Prevents very long waits; typical 30–60s for market-data streams.
 * @param {number} [opts.backoffFactor=2] exponential growth factor per failed attempt.
//               With base=1000 and factor=2: 1s, 2s, 4s, 8s, ... capped by maxDelayMs.
//               attempt counter resets only after a successful 'open'.
 * @param {number} [opts.jitterPct=0.3] randomization to avoid reconnect storms across many sockets.
//           0.3 => multiply delay by random factor in [0.7 .. 1.3].
 * @param {number} [opts.staleTimeoutMs=60000] - if no message for this long => terminate
 * @param {number} [opts.heartbeatIntervalMs=0] - application side heartbeat (=ping msg) to server. 0 means disabled
 * @param {number} [opts.autoAppPingPong] - application side ping replies (i.e. pong) to server
 * @param {(ctx: {code?: number, reason?: string, err?: any}) => number|null} [opts.delayOverrideMs]
 *        Return a number to override delay, or null/undefined for default backoff.
 */
function createReconnectWS(opts) {
  const {
    name,
    log,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    backoffFactor = 2,
    jitterPct = 0.3,
    staleTimeoutMs = 60000,
    heartbeatIntervalMs = 0, 
    autoAppPingPong = false,
    connect,
    onReconnect,        
    onOpen,
    onMessage,
    onClose,
    onError,
    delayOverrideMs,
  } = opts;

  let ws = null;
  let stopped = false;
  let attempt = 0;
  let lastMsgTs = 0;
  let staleTimer = null;
  let hbTimer = null;

  async function cleanup() {
    if (staleTimer) {
      clearInterval(staleTimer);
      staleTimer = null;
    }
    if (hbTimer) {
      clearInterval(hbTimer);
      hbTimer = null;
    }
    if (ws) {
      try { ws.removeAllListeners?.(); } catch {}
      ws = null;
    }
  }

  function startTimers(currentWs, heartbeatIntervalMs) {
    lastMsgTs = Date.now();
    // stale detection: if no messages for too long, kill socket
    if (staleTimeoutMs > 0) {
      staleTimer = setInterval(() => {
        const age = Date.now() - lastMsgTs;
        if (age > staleTimeoutMs) {
            log.warn({ name, ageMs: age, staleTimeoutMs }, 'ws stale; terminating');
          try { currentWs?.terminate?.(); }
          catch { try { currentWs?.close?.(); } catch {} }
        }
      }, clamp(Math.floor(staleTimeoutMs * 0.25), 1000, 5000));
    }
    if (heartbeatIntervalMs > 0) {
      if (hbTimer) {
        clearInterval(hbTimer);
        hbTimer = null;
      }
      hbTimer = setInterval(() => {
        if (currentWs.readyState === WebSocket.OPEN) {
          currentWs.send('ping');
        }
      }, heartbeatIntervalMs);
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
          startTimers(ws, heartbeatIntervalMs);
          if (autoAppPingPong) {
            ws.on('ping', (d) => {
              try { ws.pong(d); } catch (e) { /* ignore */ }
            });
          }
          log.info({ name }, 'ws open');
          await onOpen(ws);
        });

        ws.on('message', (data) => {
          lastMsgTs = Date.now();
          onMessage(data); 
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

        if (evt.type === 'close') {
          onClose(evt.code, evt.reason);
        } else {
          onError(evt.err);
        }

        if (stopped) break;

        await cleanup();
        attempt += 1;
        onReconnect();
        const delayMs = computeDelayMs(evt);
        log.debug({ name, attempt, delayMs, ...evt },
          'ws disconnected; reconnect scheduled'
        );
        await sleep(delayMs);
      } catch (err) {
        await cleanup();
        attempt += 1;
        onReconnect();
        const delayMs = computeDelayMs({ type: 'error', err });
        log.debug({ name, attempt, delayMs, err },
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

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;

    stopped = true;
    try { ws?.terminate?.(); } catch {}
    await cleanup();
    log.warn({ name }, 'ws stopped');
  }
  // war der versuch aufzurauemen bei beenden des node-prozesses
  // process.once('SIGINT', stop);
  // process.once('SIGTERM', stop);

  return {
    start,
    stop,
    get ws() { return ws; },
  };
}

module.exports = { createReconnectWS };
