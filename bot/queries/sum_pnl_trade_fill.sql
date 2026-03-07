\set my_interval '24 hours';
\echo Auswerteinterval: :my_interval

SELECT
  COUNT(*) AS trade_count,
  ROUND(SUM(sell_quote - buy_quote), 8) AS gross_pnl_quote,
  ROUND(SUM(sell_quote - buy_quote - buy_fee_usd - sell_fee_usd), 8) AS net_pnl_usd,
  ROUND(AVG(sell_quote - buy_quote - buy_fee_usd - sell_fee_usd), 8) AS avg_net_pnl_usd,
  ROUND(MAX(sell_quote - buy_quote - buy_fee_usd - sell_fee_usd), 8) AS max_net_pnl_usd,
  ROUND(MIN(sell_quote - buy_quote - buy_fee_usd - sell_fee_usd), 8) AS min_net_pnl_usd
FROM trade_fill
WHERE ts >= now() - interval :'my_interval';


SELECT
  symbol,
  buy_ex,
  sell_ex,
  COUNT(*) AS trade_count,
  ROUND(SUM(sell_quote - buy_quote), 8) AS gross_pnl_quote,
  ROUND(SUM(sell_quote - buy_quote - buy_fee_usd - sell_fee_usd), 8) AS net_pnl_usd,
  ROUND(AVG(sell_quote - buy_quote - buy_fee_usd - sell_fee_usd), 8) AS avg_net_pnl_usd
FROM trade_fill
WHERE ts >= now() - interval :'my_interval'
GROUP BY symbol, buy_ex, sell_ex
ORDER BY net_pnl_usd DESC
LIMIT 100;

-- SELECT *
-- FROM trade_fill
-- WHERE ts >= now() - interval :'my_interval'
-- ORDER BY ts DESC;
