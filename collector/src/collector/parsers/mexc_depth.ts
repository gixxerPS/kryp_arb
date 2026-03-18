import { getCanonFromStreamSym } from '../../common/symbolinfo';
import { getLogger } from '../../common/logger';
import { decodeMexcPushDataV3ApiWrapper } from './mexc_protobuf';

import type { ExchangeId } from '../../types/common';

const log = getLogger('collector').child({ exchange: 'mexc', sub: 'parser' });

type MexcDepthLevel = {
  price?: string | number;
  quantity?: string | number;
};

type MexcDepthPayload = {
  asks?: MexcDepthLevel[];
  bids?: MexcDepthLevel[];
  asksList?: MexcDepthLevel[];
  bidsList?: MexcDepthLevel[];
};

function toMexcLevels(levels: MexcDepthLevel[] | undefined): Array<[number, number]> {
  if (!Array.isArray(levels)) return [];

  const out: Array<[number, number]> = [];
  for (const level of levels) {
    const price = Number(level?.price);
    const qty = Number(level?.quantity);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
    out.push([price, qty]);
  }
  return out;
}

export function parseMexcDepthMessage(raw: unknown): {
  tsMs: number | null;
  symbol: string;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
} | null {
  const parsed = typeof raw === 'string'
    ? JSON.parse(raw) as any
    : (Buffer.isBuffer(raw) ? decodeMexcPushDataV3ApiWrapper(raw) : raw as any);
  const payload = (parsed?.publicLimitDepths ?? parsed?.publiclimitdepths) as MexcDepthPayload | undefined;
  const rawSymbol = parsed?.symbol;
  if (!payload || typeof rawSymbol !== 'string') return null;

  const symbol = getCanonFromStreamSym(rawSymbol, 'mexc');
  if (!symbol) return null;

  const bids = toMexcLevels(payload.bids ?? payload.bidsList);
  const asks = toMexcLevels(payload.asks ?? payload.asksList);
  if (bids.length === 0 || asks.length === 0) return null;

  const rawTs = parsed?.sendTime ?? parsed?.sendtime;
  const tsMs = Number.isFinite(Number(rawTs)) ? Number(rawTs) : null;
  return { tsMs, symbol, bids, asks };
}

export function makeMexcDepthHandler(
  { exchange = 'mexc', emit, nowMs }: { exchange?: ExchangeId; emit: (event: string, data: unknown) => void; nowMs: () => number }
): (raw: unknown) => boolean {
  return function handle(raw: unknown): boolean {
    const out = parseMexcDepthMessage(raw);
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
