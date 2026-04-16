import { gunzipSync } from 'node:zlib';

import WebSocket from 'ws';

import bus from '../bus';
import { getCfg } from '../common/config';
import { WS_STATE } from '../common/constants';
import { getExState } from '../common/exchange_state';
import { getLogger } from '../common/logger';
import { getEx } from '../common/symbolinfo';
import { createReconnectWS } from '../common/ws_reconnect';
import { makeHtxDepthHandler } from './parsers/htx_depth';

const cfg = getCfg();
const log = getLogger('collector').child({ exchange: 'htx' });

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function decodeHtxMessage(data: WebSocket.RawData): unknown {
  const buf = toBuffer(data);
  const text = buf[0] === 0x1f && buf[1] === 0x8b
    ? gunzipSync(buf).toString('utf8')
    : buf.toString('utf8');
  return JSON.parse(text);
}

function getDepthType(levels: number): string {
  if (levels <= 5) return '5';
  if (levels <= 10) return '10';
  return '20';
}

export default function startHtxDepth(): void {
  const handler = makeHtxDepthHandler({
    exchange: 'htx',
    emit: bus.emit.bind(bus),
    nowMs: () => Date.now(),
  });

  const exState = getExState();
  if (!exState) throw new Error('exchange_state not initialized');

  const symbols = cfg.symbols.filter((sym: string) => getEx(sym, 'htx')?.enabled);
  if (symbols.length === 0) {
    log.warn('no enabled htx symbols with symbolinfo');
    return;
  }

  const levels = cfg.exchanges.htx?.subscription.levels ?? 20;
  const depthLevels = getDepthType(levels);
  let activeWs: WebSocket | null = null;

  function wsSendPong(ping: number): void {
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
    activeWs.send(JSON.stringify({ pong: ping }));
  }

  const mgr = createReconnectWS({
    name: 'htx',
    log,
    connect: () => new WebSocket('wss://api-aws.huobi.pro/feed'),
    onOpen: async (ws) => {
      activeWs = ws;
      exState.onWsState('htx', WS_STATE.OPEN);
      log.info({ symbols: symbols.length, levels: depthLevels, channel: 'mbp.refresh' }, 'connected');

      for (const sym of symbols) {
        const mdKey = getEx(sym, 'htx')!.mdKey;
        ws.send(JSON.stringify({
          sub: `market.${mdKey}.mbp.refresh.${depthLevels}`,
          id: `htx-depth-${mdKey}`,
        }));
      }
    },
    onMessage: (msg) => {
      exState.onWsMessage('htx');
      try {
        const parsed = decodeHtxMessage(msg) as any;
        if (Number.isFinite(Number(parsed?.ping))) {
          wsSendPong(Number(parsed.ping));
          return;
        }
        if (parsed?.status === 'ok' && (parsed?.subbed || parsed?.unsubbed)) return;
        if (parsed?.status === 'error') {
          log.error({ parsed }, 'subscription error');
          return;
        }
        if (!parsed?.ch || !parsed?.tick) return;
        handler(parsed);
      } catch (err) {
        log.error({ err }, 'message error');
      }
    },
    onReconnect: () => exState.onWsReconnect('htx'),
    onClose: () => {
      activeWs = null;
      exState.onWsState('htx', WS_STATE.CLOSED);
    },
    onError: (err) => exState.onWsError('htx', err),
  });
  mgr.start();
}
