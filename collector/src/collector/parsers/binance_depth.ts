import { getCanonFromStreamSym } from '../../common/symbolinfo';
import { getLogger } from '../../common/logger';
import { toNumLevels } from '../../common/util';

import type { ExchangeId } from '../../types/common';

const log = getLogger('collector').child({ exchange: 'binance', sub: 'parser' });

export function parseBinanceDepthMessage(raw: unknown): { symbol: string; bids: Array<[number, number]>; asks: Array<[number, number]> } | null {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) as any : raw as any;
  if (!parsed?.stream || !parsed?.data) return null;

  const bids = Array.isArray(parsed.data.bids) ? toNumLevels(parsed.data.bids) : [];
  const asks = Array.isArray(parsed.data.asks) ? toNumLevels(parsed.data.asks) : [];
  if (bids.length === 0 || asks.length === 0) return null;

  const symbol = getCanonFromStreamSym(parsed.stream, 'binance');
  if (!symbol) return null;
  return { symbol, bids, asks };
}

export function makeBinanceDepthHandler(
  { exchange = 'binance', emit, nowMs }: { exchange?: ExchangeId; emit: (event: string, data: unknown) => void; nowMs: () => number }
): (raw: unknown) => boolean {
  return function handle(raw: unknown): boolean {
    const out = parseBinanceDepthMessage(raw);
    if (!out) {
      log.warn({ raw }, 'parse not successful for message');
      return false;
    }

    emit('md:l2', {
      tsMs: nowMs(),
      exchange,
      ...out,
    });
    return true;
  };
}
