SELECT symbol, count(*) AS n
FROM trade_intent
WHERE (buy_ex = 'bitget' OR sell_ex = 'bitget')
  AND ts > now() - interval '5 minutes'
GROUP BY 1
ORDER BY n DESC;
