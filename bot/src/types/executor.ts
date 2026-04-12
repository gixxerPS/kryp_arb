import type { AppConfig } from './config';
import type { ExchangeId, OrderSide, OrderType } from './common';

export const OrderStates = {
    FILLED: 'FILLED',
    PARTIALLY_FILLED: 'PARTIALLY_FILLED',
    CANCELLED: 'CANCELLED',
    UNKNOWN: 'UNKNOWN',
} as const;
export type OrderState = typeof OrderStates[keyof typeof OrderStates];

export type Balances = Record<string, number>;

export type PendingEntry = {
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  tmr: NodeJS.Timeout;
  requestContext?: {
    method?: string;
    params?: Record<string, unknown>;
  };
};

export type PlaceOrderParams = {
  symbol: string;          // exchange orderKey (AXSUSDC)
  side: OrderSide;
  type: OrderType;
  quantity: number;
  q?: number; // quote notional (for exchanges where MARKET BUY uses quote amount)
  price?: number;
  orderId?: string;        // euer client order id
}

export type CancelOrderParams = {
  symbol: string;
  orderId?: number | string;
}

export type UpdateBalancesParams = {
  side: OrderSide;
  baseAsset: string;
  quoteAsset: string;
  executedQty?: number;
  cummulativeQuoteQty?: number;
}

/** Minimal “common subset”, den Gate/Bitget auch liefern können */
export type CommonOrderResult = {
  exchange: ExchangeId;
  symbol: string;
  side: OrderSide;
  status: OrderState;
  orderId: number | string;
  clientOrderId?: string;
  transactTime: number;
  executedQty: number;
  cummulativeQuoteQty: number;
  priceVwap: number;
  slippage?: number;
  fee_amount: number; // rohmenge in BGB, BNB, GT, etc
  fee_currency: string; // 'BGB' | 'BNB' | 'GT' , | ....
  fee_usd: number; // USD aequivalenter wert der fees
}

export interface ExecutorAdapter {
  init(cfg: AppConfig, deps?: { bus?: any }): Promise<void>;

  isReady(): boolean;

  getBalances(): Balances;

  placeOrder(
    params: PlaceOrderParams
  ): Promise<void>;

  cancelOrder(
    params: CancelOrderParams
  ): Promise<void>;
}

export type FeePriceData = {
  asset: string;              // z.B. "BNB"
  price: number;              // z.B. 640.12
  tsMs: number;               // wann vom Exchange geholt
  sourceExchange: ExchangeId; // binance | gate
  sourceSymbol: string;       // z.B. BNBUSDT
}

export type ExecutorDayStats = {
  tsMs: number;         // day start timestamp (ms)
  pnlSum: number;
  successCount: number; // both orders filled
  failedCount: number;  // one or both orders not filled
};

export type ExecutorBlockedRoute = {
  blockedAtTsMs: number;
  exchange: ExchangeId;
  asset: string;
};

export type ExecutorBlockedRoutes = Partial<
  Record<string, Partial<Record<ExchangeId, Partial<Record<OrderSide, ExecutorBlockedRoute>>>>>
>;

export type ExecutorRuntimeState = {
  today: ExecutorDayStats;
  yesterday: ExecutorDayStats;
  blockedRoutes?: ExecutorBlockedRoutes;
};

export type UpdateRuntimeStateParams = {
  tsMs?: number;
  buyOk: boolean;
  sellOk: boolean;
  pnl?: number;
};

export type ExecutorBalancesByExchange = Partial<Record<ExchangeId, Balances>>;

export type ExecutorAccountStatus = {
  ws: 'OPEN' | 'CLOSED';
  totalBalance: number;
};

export type ExecutorAccountStatusByExchange = Partial<Record<ExchangeId, ExecutorAccountStatus>>;

export interface ExecutorHandle {
  getBalances(): ExecutorBalancesByExchange;
  getAccountStatus(): ExecutorAccountStatusByExchange;
  getRuntimeState(): ExecutorRuntimeState;
  disableOrderExecution(): void;
  enableOrderExecution(): void;
  getOrderExecutionState(): boolean;
}
