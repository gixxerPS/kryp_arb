SELECT
  exchange,
  max(ts) AS last_ts,
  now() - max(ts) AS age
FROM bbo_ticks
GROUP BY exchange
ORDER BY exchange;

SELECT
  exchange,
  symbol,
  ts,
  now() - ts AS age
FROM orderbook_depth
ORDER BY ts DESC
LIMIT 10;

