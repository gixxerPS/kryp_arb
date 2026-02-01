SELECT 
  symbol,
  buy_ex,
  sell_ex,
  expected_pnl_quote,
  size_quote,
  target_qty,
  theoretical_buy_px,
  theoretical_sell_px
FROM trade_intent
WHERE created_at >= now() - INTERVAL '24 hours'
ORDER BY created_at DESC;

