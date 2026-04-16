import { getCanonFromStreamSym } from '../../common/symbolinfo';
import { getLogger } from '../../common/logger';
import { toNumLevels } from '../../common/util';

import type { ExchangeId } from '../../types/common';

const log = getLogger('collector').child({ exchange: 'htx', sub: 'parser' });

type HtxDepthTick = {
  bids?: Array<[number | string, number | string]>;
  asks?: Array<[number | string, number | string]>;
};

type HtxDepthMessage = {
  ch?: string;
  ts?: number;
  tick?: HtxDepthTick;
};

function getRawSymbolFromChannel(ch: string): string | null {
  const match = /^market\.([a-z0-9]+)\.(?:depth\.[A-Za-z0-9_]+|mbp(?:\.refresh)?\.\d+)$/.exec(ch);
  return match?.[1] ?? null;
}

export function parseHtxDepthMessage(parsed: HtxDepthMessage): {
  tsMs: number | null;
  symbol: string;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
} | null {
  if (!parsed?.ch || !parsed?.tick) return null;

  const rawSymbol = getRawSymbolFromChannel(parsed.ch);
  if (!rawSymbol) return null;

  const symbol = getCanonFromStreamSym(rawSymbol, 'htx');
  if (!symbol) return null;

  const bids = Array.isArray(parsed.tick.bids) ? toNumLevels(parsed.tick.bids) : [];
  const asks = Array.isArray(parsed.tick.asks) ? toNumLevels(parsed.tick.asks) : [];
  if (bids.length === 0 || asks.length === 0) return null;

  const tsMs = Number.isFinite(Number(parsed.ts)) ? Number(parsed.ts) : null;
  return { tsMs, symbol, bids, asks };
}

export function makeHtxDepthHandler(
  { exchange = 'htx', emit, nowMs }: { exchange?: ExchangeId; emit: (event: string, data: unknown) => void; nowMs: () => number }
): (raw: unknown) => boolean {
  return function handle(raw: unknown): boolean {
    const out = parseHtxDepthMessage(raw as HtxDepthMessage);
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
