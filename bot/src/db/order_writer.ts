import type { DbInsert } from '../types/db';
import type { TradeOrdersOkEvent } from '../types/events';

export function buildOrderInsert(batch: TradeOrdersOkEvent[]): DbInsert {
  const cols = [
    'intent_id', 'ts', 'symbol',
    'buy_ex', 'buy_order_id', 'buy_order_ts', 'buy_status', 'buy_price', 'buy_qty', 'buy_quote',
    'buy_fee_amount', 'buy_fee_ccy', 'buy_fee_usd',
    'sell_ex', 'sell_order_id', 'sell_order_ts', 'sell_status', 'sell_price', 'sell_qty', 'sell_quote',
    'sell_fee_amount', 'sell_fee_ccy', 'sell_fee_usd'
  ];

  const params: string[] = [];
  const values: Array<string | number | Date | null> = [];
  let p = 1;

  for (const it of batch) {
    const buyOrderTs = new Date(it.buy.transactTime);
    const sellOrderTs = new Date(it.sell.transactTime);

    params.push(
      `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`
    );

    values.push(
      it.id,
      it.ts ? new Date(it.ts) : new Date(),
      it.symbol,

      it.buy.exchange,
      it.buy.orderId == null ? null : String(it.buy.orderId),
      buyOrderTs,
      it.buy.status,
      it.buy.priceVwap ?? -1,
      it.buy.executedQty ?? -1,
      it.buy.cummulativeQuoteQty ?? -1,
      it.buy.fee_amount ?? 0,
      it.buy.fee_currency ?? 'UNKNOWN',
      it.buy.fee_usd ?? 0,

      it.sell.exchange,
      it.sell.orderId == null ? null : String(it.sell.orderId),
      sellOrderTs,
      it.sell.status,
      it.sell.priceVwap ?? -1,
      it.sell.executedQty ?? -1,
      it.sell.cummulativeQuoteQty ?? -1,
      it.sell.fee_amount ?? 0,
      it.sell.fee_currency ?? 'UNKNOWN',
      it.sell.fee_usd ?? 0
    );
  }

  return {
    sql: `
      INSERT INTO public.trade_fill (${cols.join(',')})
      VALUES ${params.join(',')}
    `,
    values,
  };
}
