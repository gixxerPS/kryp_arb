const { Pool } = require('pg');

const { getLogger } = require('../logger');
const log = getLogger('db');

let pool;

function init() {
  if (pool) return pool;

  pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    log.error({ err }, 'pg pool error');
  });

  return pool;
}

async function ping() {
  if (!pool) throw new Error('db pool not initialized');
  await pool.query('SELECT 1');
  log.info('db connected');
}

async function close() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

module.exports = {
  init,
  ping,
  close,
};
