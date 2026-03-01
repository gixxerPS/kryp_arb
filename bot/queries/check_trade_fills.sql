\set my_interval '24 hours';
\echo Auswerteinterval: :my_interval

WITH filtered AS (
  SELECT
    intent_id,
    ts,
    symbol,
    buy_ex,
    -- buy_order_id,
    buy_order_ts,
    buy_status,
    buy_price,
    buy_qty,
    buy_quote,
    -- buy_fee_amount,
    -- buy_fee_ccy,
    buy_fee_usd,
    sell_ex,
    -- sell_order_id,
    sell_order_ts,
    sell_status,
    sell_price,
    sell_qty,
    sell_quote,
    -- sell_fee_amount,
    -- sell_fee_ccy,
    sell_fee_usd
  FROM trade_fill
  WHERE ts >= now() - interval :'my_interval'
),
total AS (
  SELECT COUNT(*)::text AS total_rows_text
  FROM filtered
)
SELECT
  f.intent_id,
  f.ts,
  f.symbol,
  f.buy_ex,
  -- f.buy_order_id,
  f.buy_order_ts,
  f.buy_status,
  f.buy_price,
  f.buy_qty,
  f.buy_quote,
  -- f.buy_fee_amount,
  -- f.buy_fee_ccy,
  f.buy_fee_usd,
  f.sell_ex,
  -- f.sell_order_id,
  f.sell_order_ts,
  f.sell_status,
  f.sell_price,
  f.sell_qty,
  f.sell_quote,
  -- f.sell_fee_amount,
  -- f.sell_fee_ccy,
  f.sell_fee_usd,
  t.total_rows_text
FROM filtered f
CROSS JOIN total t
ORDER BY f.ts DESC
LIMIT 50;
