export type ExchangeId = 'binance' | 'gate' | 'bitget';

export type StrategyName = 'arbitrage_v1';

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET';

export type WsParamValue = string | number | boolean | undefined | null;
export type WsParams = Record<string, WsParamValue>;

export type Balances = Record<string, number>;