// db/intent_writer.js
//
//
const bus = require('../bus');
const { getLogger } = require('../logger');
const log = getLogger('db').child({ module:'trade_intents' });

module.exports = function startIntentWriter(cfg, pool) {
  const flushIntervalMs = Number(cfg.db.flushIntervalMs) ?? 1000;   // Batch-Flush Intervall
  const maxBatch = Number(cfg.db.maxBatch) ?? 200; // Max rows pro Insert
  const strategyName = cfg.bot.strategy;
  const status = 'created';
  const q = [];
  let flushing = false;

  bus.on('trade:intent', (it) => {
    q.push(it);
    // Keine await/DB hier -> sofort zurück
    // Hot-Path soll nicht blockiert werden
    // executor soll schnellstmoeglich drankommen
  });

  async function flushOnce() {
    if (flushing) return;
    if (q.length === 0) return; // nothing to do

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
        'theoretical_buy_px',
        'theoretical_sell_px',
        'meta',
      ];
      const values = [];
      const params = [];
      let p = 1;

      for (const it of batch) {

        const expectedPnlQuote = it.q * it.net;
        const expectedPnlBps = it.net * 10_000;

        params.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);

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
          it.buyAsk,
          it.sellBid,
          it.meta ? JSON.stringify(it.meta) : null
        );
      }
      const sql = `
        INSERT INTO trade_intent (${cols.join(',')})
        VALUES ${params.join(',')}
        ON CONFLICT (id) DO NOTHING
      `;

      await pool.query(sql, values);
      log.debug({ n: batch.length }, 'wrote trade:intent batch');
    } catch (err) {
      // Batch zurück in die Queue (vorne) damit nichts verloren geht
      log.error({ err }, 'intent flush failed');
      // “best effort”: wieder vorne anstellen
      // (wenn Reihenfolge egal ist, reicht q.unshift(...batch))
      // hier safer: concat vorne
      // eslint-disable-next-line no-use-before-define
      //q.unshift(...batch);
    } finally {
      flushing = false;
    }
  }

  const t = setInterval(() => {
    // keine await im interval callback
    flushOnce().catch((err) => log.error({ err }, 'flushOnce error'));
  }, flushIntervalMs);

  return () => clearInterval(t);
};

