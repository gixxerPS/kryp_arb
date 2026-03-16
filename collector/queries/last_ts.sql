SELECT
  ts,
  symbol,
  buy_ex,
  sell_ex,
  expected_pnl_bps
FROM trade_intent
ORDER BY ts DESC
LIMIT 10;
