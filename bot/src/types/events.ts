import type { CommonOrderResult } from './executor';

export type TradeOrdersOkEvent = {
  id: string; // intent_id
  ts: string; // ISO timestamp
  symbol: string;
  buy: CommonOrderResult;
  sell: CommonOrderResult;
};
