SELECT
  exchange,
  COUNT(*) AS rows_5m,
  MAX(ts) AS last_ts,
  NOW() - MAX(ts) AS last_age
FROM bbo_ticks
WHERE ts > NOW() - INTERVAL '5 minutes'
GROUP BY 1
ORDER BY 1;

