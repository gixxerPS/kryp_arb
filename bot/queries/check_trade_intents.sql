\set my_interval '24 hours';
\echo Auswerteinterval: :my_interval

SELECT COUNT(*)::text AS total_rows_text
FROM trade_intent
WHERE ts >= now() - interval :'my_interval'
\gset
\echo total_rows: :total_rows_text

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
    ts
  FROM trade_intent
  WHERE ts >= now() - interval :'my_interval'
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
  f.ts
FROM filtered f
ORDER BY f.ts DESC
LIMIT 50;
