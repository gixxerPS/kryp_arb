import type { AppConfig } from './config';
import type { ExchangeId, OrderSide, OrderType } from './common';

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
  status?: string;
  orderId?: number | string;
  clientOrderId?: string;
  transactTime?: number;
  executedQty?: number;
  cummulativeQuoteQty?: number;
  priceVwap?: number;
  slippage?: number;
  fee_amount?: number;
  fee_currency?: string;
  fee_usd?: number;
}

export interface ExecutorAdapter {
  init(cfg: AppConfig): Promise<void>;

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