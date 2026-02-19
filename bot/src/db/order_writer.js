// db/order_writer.js
'use strict';

const bus = require('../bus');
const { getLogger } = require('../common/logger');
const log = getLogger('db').child({ module:'trade_orders' });

module.exports = function startOrderWriter(cfg, pool) {
  const flushIntervalMs = Number(cfg.db.flushIntervalMs) ?? 1000;
  const maxBatch = Number(cfg.db.maxBatch) ?? 200;

  const q = [];
  let flushing = false;

  bus.on('trade:orders_ok', (ev) => {
    q.push(ev);
  });

  async function flushOnce() {
    if (flushing) return;
    if (q.length === 0) return;

    flushing = true;
    const batch = q.splice(0, Math.min(maxBatch, q.length));

    try {
      const cols = [
        'intent_id','ts','symbol',
        'buy_ex','buy_order_id','buy_status','buy_raw',
        'sell_ex','sell_order_id','sell_status','sell_raw',
        'meta'
      ];

      const params = [];
      const values = [];
      let p = 1;

      for (const it of batch) {
        params.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);

        values.push(
          it.intent_id,
          it.ts ? new Date(it.ts) : new Date(),
          it.symbol,

          it.buy.exchange,
          it.buy.order_id,
          it.buy.status,
          it.buy.raw ? JSON.stringify(it.buy.raw) : null,

          it.sell.exchange,
          it.sell.order_id,
          it.sell.status,
          it.sell.raw ? JSON.stringify(it.sell.raw) : null,

          it.meta ? JSON.stringify(it.meta) : null
        );
      }

      const sql = `
        INSERT INTO public.trade_order_pair (${cols.join(',')})
        VALUES ${params.join(',')}
        ON CONFLICT (intent_id) DO NOTHING
      `;

      await pool.query(sql, values);
      log.debug({ n: batch.length }, 'wrote trade:orders_ok batch');
    } catch (err) {
      log.error({ err, n: batch.length }, 'order flush failed');
      // optional: batch wieder vorne anstellen, wenn du lieber retry willst
      // q.unshift(...batch);
    } finally {
      flushing = false;
    }
  }

  const t = setInterval(() => {
    flushOnce().catch((err) => log.error({ err }, 'flushOnce error'));
  }, flushIntervalMs);

  return () => clearInterval(t);
};
