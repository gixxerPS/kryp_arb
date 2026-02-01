SELECT
  COUNT(*)                          AS trade_count,
  ROUND(SUM(expected_pnl_quote), 2) AS total_expected_pnl_quote,
  ROUND(AVG(expected_pnl_quote), 2) AS avg_expected_pnl_quote,
  ROUND(MAX(expected_pnl_quote), 2) AS max_expected_pnl_quote,
  ROUND(MIN(expected_pnl_quote), 2) AS min_expected_pnl_quote,
  ROUND(AVG(size_quote), 2)         AS avg_size_quote,
  ROUND(AVG(target_qty), 2)         AS avg_target_qty
FROM trade_intent
WHERE created_at >= now() - interval '24 hours';
