import bus from '../bus';
import { getLogger } from '../common/logger';
import { buildIntentInsert } from './intent_writer';

import type { AppConfig } from '../types/config';
import type { DpClient, DpPool } from '../types/db';
import type { TradeIntent } from '../types/strategy';

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
  let flushing = false;

  const onIntent = (intent: TradeIntent): void => {
    intentQ.push(intent);
  };

  bus.on('trade:intent', onIntent);

  async function flushOnce(): Promise<void> {
    if (flushing) return;
    const intentN = Math.min(maxBatch, intentQ.length);
    if (intentN === 0) return;

    const intentBatch = intentQ.splice(0, intentN);
    flushing = true;
    try {
      await runInTransaction(pool, async (db) => {
        const { sql, values } = buildIntentInsert(intentBatch, cfg);
        await db.query(sql, values);
      });
      log.debug({ nIntent: intentBatch.length, qIntent: intentQ.length }, 'wrote db batch');
    } catch (err) {
      log.error({ err, nIntent: intentBatch.length }, 'db flush failed');
    } finally {
      flushing = false;
    }
  }

  const timer = setInterval(() => {
    void flushOnce().catch((err) => log.error({ err }, 'flushOnce error'));
  }, flushIntervalMs);

  return () => {
    clearInterval(timer);
    bus.off('trade:intent', onIntent);
  };
}
