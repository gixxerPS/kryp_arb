import type { CommonOrderResult } from './executor';
import type { ExchangeId } from './common';

export type TradeOrdersOkEvent = {
  id: string; // intent_id
  ts: string; // ISO timestamp
  symbol: string;
  buy: CommonOrderResult;
  sell: CommonOrderResult;
};

export type TradeWarnPrecheckEvent = {
  ts: string; // ISO timestamp
  symbol: string;
  side: 'BUY' | 'SELL';
  exchange: ExchangeId;
  checkReason: string;
  intentId?: string;
};
