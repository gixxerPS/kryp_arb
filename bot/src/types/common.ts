export const ExchangeIds = {
    binance: 'binance',
    gate: 'gate',
    bitget: 'bitget',
    mexc: 'mexc',
    htx: 'htx'
} as const;
export type ExchangeId = typeof ExchangeIds[keyof typeof ExchangeIds];

export type StrategyName = 'arbitrage_v1';

export const OrderSides = {
    BUY: 'BUY',
    SELL: 'SELL'
} as const;
export type OrderSide = typeof OrderSides[keyof typeof OrderSides];

export const OrderTypes = {
    LIMIT: 'LIMIT',
    MARKET: 'MARKET'
} as const;
export type OrderType = typeof OrderTypes[keyof typeof OrderTypes];

export type WsParamValue = string | number | boolean | undefined | null;
export type WsParams = Record<string, WsParamValue>;

export type Balances = Record<string, number>;
