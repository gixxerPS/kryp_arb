import type { AppConfig } from '../types/config';
import type { DbInsert } from '../types/db';
import type { TradeIntent } from '../types/strategy';

export function buildIntentInsert(batch: TradeIntent[], cfg: AppConfig): DbInsert {
  const strategyName = cfg.bot.strategy;
  const status = 'created';

  const cols = [
    'id',
    'ts',
    'symbol',
    'buy_ex',
    'sell_ex',
    'strategy',
    'status',
    'valid_until',
    'expected_pnl_quote',
    'expected_pnl_bps',
    'size_quote',
    'target_qty',
    'buy_px',
    'sell_px',
    'buy_px_worst',
    'sell_px_worst',
  ];
  const values: Array<string | number | Date | null> = [];
  const params: string[] = [];
  let p = 1;

  for (const it of batch) {
    const expectedPnlQuote = it.q * it.net;
    const expectedPnlBps = it.net * 10_000;

    params.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);

    values.push(
      it.id,
      new Date(it.tsMs),
      it.symbol,
      it.buyEx,
      it.sellEx,
      strategyName,
      status,
      it.valid_until,
      expectedPnlQuote,
      expectedPnlBps,
      it.q,
      it.targetQty,
      it.buyAsk,
      it.sellBid,
      it.buyPxWorst,
      it.sellPxWorst
    );
  }

  return {
    sql: `
      INSERT INTO public.trade_intent (${cols.join(',')})
      VALUES ${params.join(',')}
      ON CONFLICT (id) DO NOTHING
    `,
    values,
  };
}
