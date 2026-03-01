\set my_interval '24 hours';
\echo Auswerteinterval: :my_interval

WITH filtered AS (
  SELECT
    symbol,
    buy_ex,
    sell_ex,
    expected_pnl_quote,
    size_quote,
    target_qty,
    buy_px_worst,
    sell_px_worst,
    created_at
  FROM trade_intent
  WHERE created_at >= now() - interval :'my_interval'
),
total AS (
  SELECT COUNT(*)::text AS total_rows_text
  FROM filtered
)
SELECT
  f.symbol,
  f.buy_ex,
  f.sell_ex,
  f.expected_pnl_quote,
  f.size_quote,
  f.target_qty,
  f.buy_px_worst,
  f.sell_px_worst,
  f.created_at,
  t.total_rows_text
FROM filtered f
CROSS JOIN total t
ORDER BY f.created_at DESC
LIMIT 50;
