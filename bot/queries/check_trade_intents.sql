SELECT *
FROM trade_intent
WHERE created_at >= now() - INTERVAL '24 hours'
ORDER BY created_at DESC;

