import appBus from '../bus';
import { getLogger } from '../common/logger';

import type { AppConfig } from '../types/config';
import type { DpPool } from '../types/db';
import type { TradeIntent } from '../types/strategy';

const log = getLogger('db').child({ module: 'trade_intents' });

function toFiniteNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export default function startIntentWriter(cfg: AppConfig, pool: DpPool): () => void {
  const flushIntervalMs = toFiniteNumber(cfg.db.flushIntervalMs, 1000);
  const maxBatch = Math.max(1, Math.floor(toFiniteNumber(cfg.db.maxBatch, 200)));
  const strategyName = cfg.bot.strategy;
  const status = 'created';
  const q: TradeIntent[] = [];
  let flushing = false;

  appBus.on('trade:intent', (it: TradeIntent) => {
    q.push(it);
    // Keine await/DB hier -> sofort zurück
    // Hot-Path soll nicht blockiert werden
    // executor soll schnellstmoeglich drankommen
  });

  async function flushOnce(): Promise<void> {
    if (flushing) return;
    if (q.length === 0) return;

    flushing = true;
    try {
      const batch = q.splice(0, Math.min(maxBatch, q.length));

      const cols = [
        'id',
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
        'buy_px_worst',
        'sell_px_worst',
      ];
      const values: Array<string | number | Date> = [];
      const params: string[] = [];
      let p = 1;

      for (const it of batch) {
        const expectedPnlQuote = it.q * it.net;
        const expectedPnlBps = it.net * 10_000;

        params.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);

        values.push(
          it.id,
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
          it.buyPxWorst,
          it.sellPxWorst
        );
      }
      const sql = `
        INSERT INTO public.trade_intent (${cols.join(',')})
        VALUES ${params.join(',')}
        ON CONFLICT (id) DO NOTHING
      `;

      await pool.query(sql, values);
      log.debug({ n: batch.length }, 'wrote trade:intent batch');
    } catch (err) {
      log.error({ err }, 'intent flush failed');
    } finally {
      flushing = false;
    }
  }

  const t = setInterval(() => {
    flushOnce().catch((err: unknown) => log.error({ err }, 'flushOnce error'));
  }, flushIntervalMs);

  return () => clearInterval(t);
}
