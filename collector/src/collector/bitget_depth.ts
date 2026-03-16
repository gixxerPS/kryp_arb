import WebSocket from 'ws';

import bus from '../bus';
import { getCfg } from '../common/config';
import { WS_STATE } from '../common/constants';
import { getExState } from '../common/exchange_state';
import { getLogger } from '../common/logger';
import { getEx } from '../common/symbolinfo';
import { createReconnectWS } from '../common/ws_reconnect';
import { makeBitgetDepthHandler } from './parsers/bitget_depth';

const cfg = getCfg();
const log = getLogger('collector').child({ exchange: 'bitget' });

export default function startBitgetDepth(): void {
  const handler = makeBitgetDepthHandler({
    exchange: 'bitget',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });

  const exState = getExState();
  if (!exState) throw new Error('exchange_state not initialized');

  const symbols = cfg.symbols.filter((sym) => getEx(sym, 'bitget')?.enabled);
  if (symbols.length === 0) {
    log.warn('no enabled bitget symbols with symbolinfo');
    return;
  }

  const levels = cfg.exchanges.bitget?.subscription.levels ?? 15;
  const channel = levels >= 15 ? 'books15' : (levels >= 5 ? 'books5' : 'books1');

  const mgr = createReconnectWS({
    name: 'bitget:depth',
    log,
    heartbeatIntervalMs: 20_000,
    connect: () => new WebSocket('wss://ws.bitget.com/v2/ws/public'),
    onOpen: async (ws) => {
      exState.onWsState('bitget', WS_STATE.OPEN);
      log.info({ symbols: symbols.length, levels }, 'connected');
      const args = symbols.map((sym) => ({
        instType: 'SPOT',
        channel,
        instId: getEx(sym, 'bitget')!.mdKey,
      }));
      ws.send(JSON.stringify({ op: 'subscribe', args }));
    },
    onMessage: (msg) => {
      exState.onWsMessage('bitget');
      try {
        const msgStr = msg.toString();
        if (msgStr === 'pong') return;
        const parsed = JSON.parse(msgStr);
        if (parsed.event === 'subscribe') return;
        if (parsed.event === 'error') {
          log.error({ parsed }, 'subscribe error');
          return;
        }
        if (!Array.isArray(parsed.data) || parsed.data.length === 0) return;
        handler(parsed);
      } catch (err) {
        log.error({ err }, 'message error');
      }
    },
    onReconnect: () => exState.onWsReconnect('bitget'),
    onClose: () => exState.onWsState('bitget', WS_STATE.CLOSED),
    onError: (err) => exState.onWsError('bitget', err),
  });

  mgr.start();
}
