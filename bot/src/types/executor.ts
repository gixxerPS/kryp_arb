import type { AppConfig } from './config';
import type { ExchangeId, OrderSide, OrderType } from './common';

export const OrderStates = {
    FILLED: 'FILLED',
    CANCELLED: 'CANCELLED',
    UNKNOWN: 'UNKNOWN',
} as const;
export type OrderState = typeof OrderStates[keyof typeof OrderStates];

export type Balances = Record<string, number>;

export type PendingEntry = {
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  tmr: NodeJS.Timeout;
};

export type PlaceOrderParams = {
  symbol: string | null;          // exchange orderKey (AXSUSDC)
  side: OrderSide;
  type: OrderType;
  quantity: number;
  q?: number; // quote notional (for exchanges where MARKET BUY uses quote amount)
  price?: number;
  orderId?: string;        // euer client order id
}

export type CancelOrderParams = {
  symbol: string | null;
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
  status: OrderState;
  orderId: number | string;
  clientOrderId?: string;
  transactTime: number;
  executedQty: number;
  cummulativeQuoteQty: number;
  priceVwap: number;
  slippage?: number;
  fee_amount: number;
  fee_currency: string;
  fee_usd: number;
}

export interface ExecutorAdapter {
  init(cfg: AppConfig): Promise<void>;

  isReady(): boolean;

  getBalances(): Balances;

  updateBalancesFromOrderData(params: UpdateBalancesParams): void;

  placeOrder(
    test: boolean,
    params: PlaceOrderParams
  ): Promise<CommonOrderResult>;

  cancelOrder(
    params: CancelOrderParams
  ): Promise<CommonOrderResult>;
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

export type ExecutorRuntimeState = {
  today: ExecutorDayStats;
  yesterday: ExecutorDayStats;
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
}
