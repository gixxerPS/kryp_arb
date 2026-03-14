import type { CommonOrderResult } from './executor';
import type { ExchangeId } from './common';

export type TradeOrdersOkEvent = {
  id: string; // intent_id
  ts: Date;
  symbol: string;
  buy: CommonOrderResult;
  sell: CommonOrderResult;
  pnl: number;
  deltaBalanceBase: number;
};

export type TradeWarnPrecheckEvent = {
  ts: Date;
  symbol: string;
  side: 'BUY' | 'SELL';
  exchange: ExchangeId;
  checkReason: string;
  checkReasonDesc: string;
  intentId?: string;
};
