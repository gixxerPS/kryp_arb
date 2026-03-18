export const ExchangeIds = {
  binance: 'binance',
  gate: 'gate',
  bitget: 'bitget',
  mexc: 'mexc',
} as const;

export type ExchangeId = typeof ExchangeIds[keyof typeof ExchangeIds];

export type StrategyName = 'arbitrage_v1';
