import { getCanonFromStreamSym, getEx } from '../../common/symbolinfo';
import { getLogger } from '../../common/logger';
import { toNumLevels } from '../../common/util';

import type { ExchangeId } from '../../types/common';

const log = getLogger('collector').child({ exchange: 'bitget', sub: 'parser' });

export function parseBitgetDepthMessage(parsed: any): { tsMs: number | null; symbol: string; bids: Array<[number, number]>; asks: Array<[number, number]> } | null {
  if (!parsed?.arg || (parsed.action !== 'snapshot' && parsed.action !== 'update')) return null;
  const instId = parsed.arg.instId;
  const dataArr = Array.isArray(parsed.data) ? parsed.data : [];
  if (!instId || dataArr.length === 0) return null;

  const data = dataArr[0];
  const bids = Array.isArray(data?.bids) ? toNumLevels(data.bids) : [];
  const asks = Array.isArray(data?.asks) ? toNumLevels(data.asks) : [];
  if (bids.length === 0 || asks.length === 0) return null;

  const symbol = getCanonFromStreamSym(instId, 'bitget');
  if (!symbol) return null;

  const expectedChannel = getEx(symbol, 'bitget')?.extra.channel;
  if (parsed.arg.channel !== expectedChannel) return null;

  const tsMs = Number.isFinite(Number(data.ts)) ? Number(data.ts) : null;
  return { tsMs, symbol, bids, asks };
}

export function makeBitgetDepthHandler(
  { exchange = 'bitget', emit, nowMs }: { exchange?: ExchangeId; emit: (event: string, data: unknown) => void; nowMs: () => number }
): (raw: unknown) => boolean {
  return function handle(raw: unknown): boolean {
    const out = parseBitgetDepthMessage(raw as any);
    if (!out) {
      log.warn({ raw }, 'parse not successful for message');
      return false;
    }

    emit('md:l2', {
      tsMs: out.tsMs ?? nowMs(),
      exchange,
      symbol: out.symbol,
      bids: out.bids,
      asks: out.asks,
    });
    return true;
  };
}
