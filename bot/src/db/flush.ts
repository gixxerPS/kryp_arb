import appBus from '../bus';
import { getLogger } from '../common/logger';

import type { AppConfig } from '../types/config';
import type { DpClient } from '../types/db';
import type { DpPool } from '../types/db';
import type { TradeOrdersOkEvent } from '../types/events';
import type { TradeIntent } from '../types/strategy';
import { buildIntentInsert } from './intent_writer';
import { buildOrderInsert } from './order_writer';

const log = getLogger('db').child({ module: 'flush' });

function toFiniteNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

async function runInTransaction(pool: DpPool, fn: (db: DpPool | DpClient) => Promise<void>): Promise<void> {
  if (!pool.connect) {
    await fn(pool);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      log.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

export default function startDbFlush(cfg: AppConfig, pool: DpPool): () => void {
  const flushIntervalMs = toFiniteNumber(cfg.db.flushIntervalMs, 5000);
  const maxBatch = Math.max(1, Math.floor(toFiniteNumber(cfg.db.maxBatch, 200)));

  const intentQ: TradeIntent[] = [];
  const orderQ: TradeOrdersOkEvent[] = [];
  let flushing = false;

  const onIntent = (intent: TradeIntent): void => {
    intentQ.push(intent);
  };

  const onOrdersOk = (ev: TradeOrdersOkEvent): void => {
    orderQ.push(ev);
  };

  appBus.on('trade:intent', onIntent);
  appBus.on('trade:orders_ok', onOrdersOk);

  async function flushOnce(): Promise<void> {
    if (flushing) return;

    const intentN = Math.min(maxBatch, intentQ.length);
    const orderN = Math.min(maxBatch, orderQ.length);
    if (intentN === 0 && orderN === 0) return;

    const intentBatch = intentQ.splice(0, intentN);
    const orderBatch = orderQ.splice(0, orderN);

    flushing = true;
    try {
      await runInTransaction(pool, async (db) => {
        if (intentBatch.length > 0) {
          const { sql, values } = buildIntentInsert(intentBatch, cfg);
          await db.query(sql, values);
        }

        if (orderBatch.length > 0) {
          const { sql, values } = buildOrderInsert(orderBatch);
          await db.query(sql, values);
        }
      });
      log.debug({
          nIntent: intentBatch.length,
          nOrder: orderBatch.length,
          qIntent: intentQ.length,
          qOrder: orderQ.length,
        }, 'wrote db batch');
    } catch (err) {
      log.error({ err, nIntent: intentBatch.length, nOrder: orderBatch.length }, 'db flush failed');
      // Performance-first: bei Fehler droppen wir den fehlgeschlagenen Batch
      // und blockieren nicht den Hot-Path mit Retries/Requeue.
    } finally {
      flushing = false;
    }
  }

  const t = setInterval(() => {
    flushOnce().catch((err: unknown) => log.error({ err }, 'flushOnce error'));
  }, flushIntervalMs);

  return () => {
    clearInterval(t);
    appBus.off('trade:intent', onIntent);
    appBus.off('trade:orders_ok', onOrdersOk);
  };
}
