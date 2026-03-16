import type { EventEmitter } from 'node:events';
import type { AppConfig } from './config';
import type { ExchangeId } from './common';

export type TradeIntent = {
  id: string;
  tsMs: number;
  valid_until: Date;
  symbol: string;
  buyEx: ExchangeId;
  sellEx: ExchangeId;
  targetQty: number;
  net: number;
  qBuy: number;
  qSell: number;
  buyPxEff: number;
  sellPxEff: number;
  expectedPnl: number;
  buyAsk: number;
  sellBid: number;
  buyPxWorst: number;
  sellPxWorst: number;
};

export type TradeIntentDraft = Omit<TradeIntent, 'id' | 'tsMs' | 'valid_until'>;
export type L2Level = [number | string, number | string];

export type L2Snapshot = {
  tsMs: number;
  exchange: ExchangeId;
  symbol: string;
  bids: L2Level[];
  asks: L2Level[];
};

export type ExchangeStateLike = {
  getExchangeState: (exchange: ExchangeId) => unknown;
};

export type ComputeIntentsForSymArgs = {
  sym: string;
  latest: Map<string, L2Snapshot>;
  fees: AppConfig['exchanges'];
  nowMs: number;
  cfg: AppConfig;
  exState: ExchangeStateLike;
};

export type ComputeIntentsForSym = (params: ComputeIntentsForSymArgs) => TradeIntentDraft[];

export type StrategyDeps = {
  bus?: EventEmitter;
  getExState?: () => ExchangeStateLike | null;
  computeIntentsForSymbol?: ComputeIntentsForSym;
  nowFn?: () => number;
  uuidFn?: () => string;
};
