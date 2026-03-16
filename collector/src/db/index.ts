import { Pool } from 'pg';

import startDbFlush from './flush';
import { getLogger } from '../common/logger';

import type { AppConfig } from '../types/config';
import type { DpPool } from '../types/db';

const log = getLogger('db');

type PgPool = DpPool & {
  on: (event: 'error', listener: (err: unknown) => void) => void;
  end: () => Promise<void>;
};

let pool: PgPool | null = null;
let stopFlush: (() => void) | null = null;

export function init(cfg: AppConfig): PgPool {
  if (pool) return pool;

  pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  }) as PgPool;

  pool.on('error', (err) => {
    log.error({ err }, 'pg pool error');
  });

  stopFlush = startDbFlush(cfg, pool);
  return pool;
}

export async function ping(): Promise<void> {
  if (!pool) throw new Error('db pool not initialized');
  await pool.query('SELECT 1');
  log.info('db connected');
}

export async function close(): Promise<void> {
  if (stopFlush) {
    stopFlush();
    stopFlush = null;
  }
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
