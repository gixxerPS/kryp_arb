SELECT
  exchange,
  count(*) FILTER (WHERE ts > now() - interval '24 hours') AS rows_5m,
  --count(*) FILTER (WHERE ts > now() - interval '5 minutes') AS rows_5m,
  max(ts) AS last_ts
FROM orderbook_depth
GROUP BY exchange
ORDER BY exchange;

