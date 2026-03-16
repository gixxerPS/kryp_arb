import WebSocket from 'ws';

import bus from '../bus';
import { getCfg } from '../common/config';
import { WS_STATE } from '../common/constants';
import { getExState } from '../common/exchange_state';
import { getLogger } from '../common/logger';
import { getEx } from '../common/symbolinfo';
import { createReconnectWS } from '../common/ws_reconnect';
import { makeGateDepthHandler } from './parsers/gate_depth';

const cfg = getCfg();
const log = getLogger('collector').child({ exchange: 'gate' });

export default function startGateDepth(): void {
  const handler = makeGateDepthHandler({
    exchange: 'gate',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });

  const exState = getExState();
  if (!exState) throw new Error('exchange_state not initialized');

  const symbols = cfg.symbols.filter((sym) => getEx(sym, 'gate')?.enabled);
  if (symbols.length === 0) {
    log.warn('no enabled gate symbols with symbolinfo');
    return;
  }

  const mgr = createReconnectWS({
    name: 'gate',
    log,
    heartbeatIntervalMs: 20_000,
    connect: () => new WebSocket('wss://api.gateio.ws/ws/v4/'),
    onOpen: async (ws) => {
      exState.onWsState('gate', WS_STATE.OPEN);
      const levels = `${cfg.exchanges.gate?.subscription.levels ?? 10}`;
      const updateMs = `${cfg.exchanges.gate?.subscription.updateMs ?? 100}ms`;
      log.info({ symbols: symbols.length, levels, updateMs }, 'connected');

      for (const sym of symbols) {
        const mdKey = getEx(sym, 'gate')!.mdKey;
        ws.send(JSON.stringify({
          time: Math.floor(Date.now() / 1000),
          channel: 'spot.order_book',
          event: 'subscribe',
          payload: [mdKey, levels, updateMs],
        }));
      }
    },
    onMessage: (msg) => {
      exState.onWsMessage('gate');
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.event === 'subscribe') return;
        if (parsed.event === 'error') {
          log.error({ parsed }, 'subscribe error');
          return;
        }
        if (parsed.event !== 'update' || parsed.channel !== 'spot.order_book' || !parsed.result) return;
        handler(parsed);
      } catch (err) {
        log.error({ err }, 'message error');
      }
    },
    onReconnect: () => exState.onWsReconnect('gate'),
    onClose: () => exState.onWsState('gate', WS_STATE.CLOSED),
    onError: (err) => exState.onWsError('gate', err),
  });

  mgr.start();
}
