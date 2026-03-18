import WebSocket from 'ws';

import bus from '../bus';
import { getCfg } from '../common/config';
import { WS_STATE } from '../common/constants';
import { getExState } from '../common/exchange_state';
import { getLogger } from '../common/logger';
import { getEx } from '../common/symbolinfo';
import { createReconnectWS } from '../common/ws_reconnect';
import { makeMexcDepthHandler } from './parsers/mexc_depth';

const cfg = getCfg();
const log = getLogger('collector').child({ exchange: 'mexc' });

function normalizeDepthLevels(levels: number): 5 | 10 | 20 {
  if (levels >= 20) return 20;
  if (levels >= 10) return 10;
  return 5;
}

export default function startMexcDepth(): void {
  const handler = makeMexcDepthHandler({
    exchange: 'mexc',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });

  const exState = getExState();
  if (!exState) throw new Error('exchange_state not initialized');

  const symbols = cfg.symbols.filter((sym) => getEx(sym, 'mexc')?.enabled);
  if (symbols.length === 0) {
    log.warn('no enabled mexc symbols with symbolinfo');
    return;
  }

  const levels = normalizeDepthLevels(cfg.exchanges.mexc?.subscription.levels ?? 10);
  const params = symbols.map((sym) => `spot@public.limit.depth.v3.api.pb@${getEx(sym, 'mexc')!.mdKey}@${levels}`);

  const mgr = createReconnectWS({
    name: 'mexc',
    log,
    heartbeatIntervalMs: 20_000,
    connect: () => new WebSocket('wss://wbs-api.mexc.com/ws'),
    onOpen: async (ws) => {
      exState.onWsState('mexc', WS_STATE.OPEN);
      log.info({ symbols: symbols.length, levels }, 'connected');
      ws.send(JSON.stringify({
        method: 'SUBSCRIPTION',
        params,
      }));
    },
    onMessage: (msg) => {
      exState.onWsMessage('mexc');
      try {
        if (typeof msg === 'string') {
          if (msg === 'pong') return;
          const parsed = JSON.parse(msg);
          if (parsed?.msg === 'PONG') return;
          if (typeof parsed?.code === 'number' && parsed.code !== 0) {
            log.error({ parsed }, 'subscription error');
          }
          return;
        }

        if (Buffer.isBuffer(msg)) {
          const maybeText = msg.toString('utf8');
          if (maybeText === 'pong') return;
          if (maybeText.startsWith('{')) {
            const parsed = JSON.parse(maybeText);
            if (parsed?.msg === 'PONG') return;
            if (typeof parsed?.code === 'number' && parsed.code !== 0) {
              log.error({ parsed }, 'subscription error');
            }
            return;
          }
          handler(msg);
          return;
        }

        log.warn({ msgType: typeof msg }, 'unsupported mexc ws message type');
      } catch (err) {
        log.error({ err }, 'message error');
      }
    },
    onReconnect: () => exState.onWsReconnect('mexc'),
    onClose: () => exState.onWsState('mexc', WS_STATE.CLOSED),
    onError: (err) => exState.onWsError('mexc', err),
  });

  mgr.start();
}
