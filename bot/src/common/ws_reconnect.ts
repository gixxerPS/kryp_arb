import WebSocket from 'ws';

import { clamp, sleep, withJitter } from './util';

type CloseCtx = {
  type: 'close' | 'error';
  code?: number;
  reason?: string | Buffer;
  err?: Error;
};

type ReconnectOpts = {
  name: string;
  log: { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  connect: () => WebSocket;
  onOpen: (ws: WebSocket) => void | Promise<void>;
  onMessage: (data: any) => void;
  onReconnect: () => void;
  onClose: (code: number, reason: any) => void;
  onError: (err: Error) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitterPct?: number;
  staleTimeoutMs?: number | null;
  heartbeatIntervalMs?: number;
  heartbeatMessageFactory?: () => unknown;
  autoAppPingPong?: boolean;
  delayOverrideMs?: (ctx: CloseCtx) => number | null | undefined;
};

type ReconnectManager = {
  start: () => void;
  stop: () => Promise<void>;
};

export function createReconnectWS(opts: ReconnectOpts): ReconnectManager {
  const {
    name,
    log,
    connect,
    onOpen,
    onMessage,
    onReconnect,
    onClose,
    onError,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    backoffFactor = 2,
    jitterPct = 0.3,
    staleTimeoutMs = 60000,
    heartbeatIntervalMs = 0,
    heartbeatMessageFactory, // defaults to () => 'ping'
    autoAppPingPong = false,
    delayOverrideMs,
  } = opts;

  let ws: WebSocket | null = null;
  let stopped = false;
  let stopping = false;
  let attempt = 0;
  let lastMsgTs = 0;
  let staleTimer: NodeJS.Timeout | null = null;
  let hbTimer: NodeJS.Timeout | null = null;

  async function cleanup(): Promise<void> {
    if (staleTimer) clearInterval(staleTimer);
    if (hbTimer) clearInterval(hbTimer);
    staleTimer = null;
    hbTimer = null;
    if (ws) {
      ws.removeAllListeners();
      ws = null;
    }
  }

  function startTimers(currentWs: WebSocket): void {
    lastMsgTs = Date.now();
    const effectiveStaleTimeoutMs = staleTimeoutMs ?? 0;

    if (effectiveStaleTimeoutMs > 0) {
      staleTimer = setInterval(() => {
        const age = Date.now() - lastMsgTs;
        if (age > effectiveStaleTimeoutMs) {
          log.warn({ name, ageMs: age, staleTimeoutMs: effectiveStaleTimeoutMs }, 'ws stale; terminating');
          try {
            currentWs.terminate();
          } catch {
            try {
              currentWs.close();
            } catch {
              // ignore close errors
            }
          }
        }
      }, clamp(Math.floor(effectiveStaleTimeoutMs * 0.25), 1000, 5000));
    }

    if (heartbeatIntervalMs > 0) {
      hbTimer = setInterval(() => {
        if (currentWs.readyState === WebSocket.OPEN) {
          try {
            const payload = heartbeatMessageFactory ? heartbeatMessageFactory() : 'ping';
            if (payload == null) return;
            if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
              currentWs.send(payload);
              return;
            }
            currentWs.send(JSON.stringify(payload));
          } catch (err) {
            log.warn({ name, err }, 'ws heartbeat send failed');
          }
        }
      }, heartbeatIntervalMs);
    }
  }

  function computeDelayMs(ctx: CloseCtx): number {
    const overridden = delayOverrideMs?.(ctx);
    if (Number.isFinite(overridden)) {
      return Math.max(0, Number(overridden));
    }
    const raw = clamp(baseDelayMs * Math.pow(backoffFactor, attempt), baseDelayMs, maxDelayMs);
    return withJitter(raw, jitterPct);
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        ws = connect();

        const evt = await new Promise<CloseCtx>((resolve) => {
          ws!.on('open', async () => {
            if (stopped || !ws) return;
            attempt = 0;
            startTimers(ws);
            if (autoAppPingPong) {
              ws.on('ping', (data) => {
                try {
                  ws?.pong(data);
                } catch {
                  // ignore pong errors
                }
              });
            }
            await onOpen(ws);
          });

          ws!.on('message', (data) => {
            lastMsgTs = Date.now();
            onMessage(data);
          });

          ws!.on('pong', () => {
            lastMsgTs = Date.now();
          });

          ws!.on('close', (code, reason) => {
            resolve({ type: 'close', code, reason: reason.toString() });
          });

          ws!.on('error', (err) => {
            resolve({ type: 'error', err });
          });
        });

        if (evt.type === 'close') {
          onClose(evt.code ?? 0, evt.reason ?? '');
        } else if (evt.err) {
          onError(evt.err);
        }

        if (stopped) break;

        await cleanup();
        attempt += 1;
        onReconnect();
        const delayMs = computeDelayMs(evt);
        log.debug({ name, attempt, delayMs, ...evt }, 'ws disconnected; reconnect scheduled');
        await sleep(delayMs);
      } catch (err) {
        await cleanup();
        attempt += 1;
        onReconnect();
        const nextErr = err as Error;
        const delayMs = computeDelayMs({ type: 'error', err: nextErr });
        log.debug({ name, attempt, delayMs, err: nextErr }, 'ws loop error; reconnect scheduled');
        await sleep(delayMs);
      }
    }
  }

  return {
    start() {
      stopped = false;
      void loop();
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      stopped = true;
      try {
        ws?.terminate();
      } catch {
        // ignore terminate errors
      }
      await cleanup();
      log.warn({ name }, 'ws stopped');
    },
  };
}
