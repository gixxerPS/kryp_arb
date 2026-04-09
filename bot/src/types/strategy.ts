import type { EventEmitter } from 'node:events';
import type { AppConfig } from './config';
import type { ExchangeId } from './common';

export type TradeIntent = {
  id            : string;     /** unique id */
  tsMs          : number;     /** timestamp created at */
  valid_until   : Date;       /** tsMs + cfg.bot.intent_time_to_live_ms */

  symbol        : string;     /** e.g. AXS_USDT */

  buyEx         : ExchangeId; /** e.g. binance */
  sellEx        : ExchangeId; /** e.g. gate */

  targetQty     : number;     /** e.g. 127 [AXS] */
  net           : number;     /** net spread incl slippage worst px and fees, e.g. 0.0012 (no %!) */
  
  qBuy          : number;     /** expected liquidity of buy leg, i.e. avg buy price * targetQty */
  qSell         : number;     /** expected liquidity of buy leg, i.e. avg sell price * targetQty */
  buyPxEff      : number;     /** qBuy / targetQty */
  sellPxEff     : number;     /** qSell / targetQty */

  expectedPnl   : number;     /** qSell - qBuy */

  buyAsk        : number;     /** best ask px */
  sellBid       : number;     /** best bid px */

  buyPxWorst    : number;     /** worst case ask px (incl slippage) -> buy price should be better than this */
  sellPxWorst   : number;     /** worst case bid px (incl slippage) -> sell price should be better than this */
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

export type StrategyLatestMapEntry = {
  snapshotKey: string;
  exchange: ExchangeId;
  symbol: string;
  tsMs: number;
  bids: string;
  asks: string;
};

export type StrategyLatestMapView = Record<string, StrategyLatestMapEntry>;

export interface StrategyHandle {
  getLatestMap(symbol?: string): StrategyLatestMapView;
}
