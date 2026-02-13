\set my_interval '24 hours';
\echo Auswerteinterval: :my_interval
SELECT
  COUNT(*)                          AS trade_count,
  ROUND(SUM(expected_pnl_quote), 2) AS total_expected_pnl_quote,
  ROUND(AVG(expected_pnl_quote), 2) AS avg_expected_pnl_quote,
  ROUND(MAX(expected_pnl_quote), 2) AS max_expected_pnl_quote,
  ROUND(MIN(expected_pnl_quote), 2) AS min_expected_pnl_quote,
  ROUND(AVG(size_quote), 2)         AS avg_size_quote,
  ROUND(AVG(target_qty), 2)         AS avg_target_qty
FROM trade_intent
WHERE created_at >= now() - interval :'my_interval';


SELECT
  symbol,
  buy_ex,
  sell_ex,
  COUNT(*) AS trade_count
FROM trade_intent
WHERE created_at >= now() - interval :'my_interval'
GROUP BY symbol, buy_ex, sell_ex
ORDER BY trade_count DESC
LIMIT 50;

-- SELECT *
-- FROM trade_intent
-- WHERE created_at >= now() - interval :'my_interval';