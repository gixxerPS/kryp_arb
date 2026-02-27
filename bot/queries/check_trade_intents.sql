SELECT 
  symbol,
  buy_ex,
  sell_ex,
  expected_pnl_quote,
  size_quote,
  target_qty,
  buy_px_worst,
  sell_px_worst,
  created_at
FROM trade_intent
WHERE created_at >= now() - INTERVAL '24 hours'
ORDER BY created_at DESC;
