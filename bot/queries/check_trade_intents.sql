SELECT
  created_at,
  symbol,
  buy_ex,
  sell_ex,
  status,
  buy_ask,
  sell_bid
FROM trade_intent
WHERE created_at >= now() - INTERVAL '10 minutes'
ORDER BY created_at DESC;

