SELECT 
  symbol,
  COUNT(*) AS cnt
FROM trade_intent
GROUP BY symbol
ORDER BY cnt DESC;
