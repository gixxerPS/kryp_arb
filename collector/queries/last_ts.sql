SELECT
  exchange,
  max(ts) AS last_ts,
  now() - max(ts) AS age
FROM bbo_ticks
GROUP BY exchange
ORDER BY exchange;

