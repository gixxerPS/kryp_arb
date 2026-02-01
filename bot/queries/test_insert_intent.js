// test_insert_intent.js
const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const pool = new Pool({
  host: 'localhost',
  database: 'arb',
  user: 'arbuser',
  // password: process.env.PGPASSWORD, // falls nötig
});

(async () => {
  const client = await pool.connect();
  try {
    // Sanity-Check: welcher User?
    const who = await client.query(
      'SELECT current_user, current_schema()'
    );
    console.log(who.rows[0]);

    const sql = `
      INSERT INTO public.trade_intent (
        id,
        symbol,
        buy_ex,
        sell_ex,
        strategy,
        status,
        valid_until,
        expected_pnl_quote,
        expected_pnl_bps,
        size_quote,
        target_qty,
        theoretical_buy_px,
        theoretical_sell_px,
        meta
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb
      )
    `;

    const values = [
      randomUUID(),
      'TEST_USDT',
      'bitget',
      'binance',
      'test_strategy',
      'OPEN',
      new Date(Date.now() + 60_000), // +1 min
      1.23,          // expected_pnl_quote
      12.3,          // expected_pnl_bps
      5000,          // size_quote
      42.0,          // target_qty
      1.2345,        // theoretical_buy_px
      1.2360,        // theoretical_sell_px
      JSON.stringify({ note: 'manual test insert' }),
    ];

    await client.query(sql, values);
    console.log('OK: test trade_intent inserted');
  } catch (e) {
    console.error(e);
  } finally {
    client.release();
    await pool.end();
  }
})();

