WITH intent_exchanges AS (
  SELECT buy_ex AS exchange, ts
  FROM trade_intent
  WHERE ts > NOW() - INTERVAL '5 minutes'
  UNION ALL
  SELECT sell_ex AS exchange, ts
  FROM trade_intent
  WHERE ts > NOW() - INTERVAL '5 minutes'
)
SELECT
  exchange,
  COUNT(*) AS intents_5m,
  MAX(ts) AS last_ts,
  NOW() - MAX(ts) AS last_age
FROM intent_exchanges
GROUP BY 1
ORDER BY 1;
