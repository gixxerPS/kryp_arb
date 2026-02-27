const { Pool } = require('pg');

import { getLogger } from '../common/logger';
import type { DpPool } from '../types/db';

const log = getLogger('db');

type PgPool = DpPool & {
  on: (event: 'error', listener: (err: unknown) => void) => void;
  end: () => Promise<void>;
};

let pool: PgPool | null = null;

function init(): PgPool {
  if (pool) return pool;

  pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  }) as PgPool;

  pool.on('error', (err: unknown) => {
    log.error({ err }, 'pg pool error');
  });

  pool
    .query("SELECT current_user, current_schema(), current_setting('search_path') AS search_path")
    .then((res: any) => {
      log.debug(res.rows[0], 'db session info');
    })
    .catch((err: unknown) => {
      log.error(err, 'db session info failed');
    });

  return pool;
}

async function ping(): Promise<void> {
  if (!pool) throw new Error('db pool not initialized');
  await pool.query('SELECT 1');
  log.info('db connected');
}

async function close(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

export default {
  init,
  ping,
  close,
};

