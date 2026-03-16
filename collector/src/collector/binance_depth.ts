import WebSocket from 'ws';

import bus from '../bus';
import { getCfg } from '../common/config';
import { WS_STATE } from '../common/constants';
import { getExState } from '../common/exchange_state';
import { getLogger } from '../common/logger';
import { getEx } from '../common/symbolinfo';
import { createReconnectWS } from '../common/ws_reconnect';
import { makeBinanceDepthHandler } from './parsers/binance_depth';

const cfg = getCfg();
const log = getLogger('collector').child({ exchange: 'binance' });

export default function startBinanceDepth(): void {
  const handler = makeBinanceDepthHandler({
    exchange: 'binance',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });

  const exState = getExState();
  if (!exState) throw new Error('exchange_state not initialized');

  const symbols = cfg.symbols.filter((sym) => getEx(sym, 'binance')?.enabled);
  const streams = symbols.map((sym) => getEx(sym, 'binance')!.mdKey);
  if (streams.length === 0) {
    log.warn('no enabled binance symbols with symbolinfo');
    return;
  }

  const levels = cfg.exchanges.binance?.subscription.levels;
  const updateMs = cfg.exchanges.binance?.subscription.updateMs;
  const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;

  const mgr = createReconnectWS({
    name: 'binance',
    log,
    connect: () => new WebSocket(url),
    onOpen: async () => {
      exState.onWsState('binance', WS_STATE.OPEN);
      log.info({ symbols: streams.length, levels, updateMs }, 'connected');
    },
    onMessage: (msg) => {
      exState.onWsMessage('binance');
      try {
        handler(JSON.parse(msg.toString()));
      } catch (err) {
        log.error({ err }, 'message error');
      }
    },
    onReconnect: () => exState.onWsReconnect('binance'),
    onClose: () => exState.onWsState('binance', WS_STATE.CLOSED),
    onError: (err) => exState.onWsError('binance', err),
  });

  mgr.start();
}
