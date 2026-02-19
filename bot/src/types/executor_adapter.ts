import type { AppConfig } from './config';
import type { ExchangeId, OrderSide, OrderType } from './common';

export type Balances = Record<string, number>;

export type PendingEntry = {
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  tmr: NodeJS.Timeout;
};

export interface PlaceOrderParams {
  symbol: string;          // exchange orderKey (AXSUSDC)
  side: OrderSide;
  type: OrderType;
  quantity: number | string; // du gibst aktuell number; später besser string
  price?: number | string;
  orderId?: string;        // euer client order id
}

export interface CancelOrderParams {
  symbol: string;
  origClientOrderId?: string;
  orderId?: number | string;
}

/** Minimal “common subset”, den Gate/Bitget auch liefern können */
export interface CommonOrderResult {
  exchange: ExchangeId;
  symbol: string;
  status?: string;
  orderId?: number | string;
  clientOrderId?: string;
  transactTime?: number;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  price?: string;
  fills?: Array<{
    price: string;
    qty: string;
    commission?: string;
    commissionAsset?: string;
    tradeId?: number | string;
  }>;
}

export interface ExecutorAdapter {
  init(cfg: AppConfig): Promise<void>;

  getStartupBalances(cfg: AppConfig): Promise<Balances>;

  placeOrder(
    test: boolean,
    params: PlaceOrderParams
  ): Promise<CommonOrderResult>;

  cancelOrder(
    params: CancelOrderParams
  ): Promise<CommonOrderResult>;
}