import { getCanonFromStreamSym } from '../../common/symbolinfo';
import { getLogger } from '../../common/logger';
import { toNumLevels } from '../../common/util';

import type { ExchangeId } from '../../types/common';

const log = getLogger('collector').child({ exchange: 'gate', sub: 'parser' });

export function parseGateDepthMessage(parsed: any): { tsMs: number | null; symbol: string; bids: Array<[number, number]>; asks: Array<[number, number]> } | null {
  if (!parsed || parsed.channel !== 'spot.order_book' || parsed.event !== 'update' || !parsed.result) return null;

  const symbol = getCanonFromStreamSym(parsed.result.s, 'gate');
  if (!symbol) return null;

  const bids = Array.isArray(parsed.result.bids) ? toNumLevels(parsed.result.bids) : [];
  const asks = Array.isArray(parsed.result.asks) ? toNumLevels(parsed.result.asks) : [];
  if (bids.length === 0 || asks.length === 0) return null;

  const tsMs = Number.isFinite(Number(parsed.result.t)) ? Number(parsed.result.t) * 1000 : null;
  return { tsMs, symbol, bids, asks };
}

export function makeGateDepthHandler(
  { exchange = 'gate', emit, nowMs }: { exchange?: ExchangeId; emit: (event: string, data: unknown) => void; nowMs: () => number }
): (raw: unknown) => boolean {
  return function handle(raw: unknown): boolean {
    const out = parseGateDepthMessage(raw as any);
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
