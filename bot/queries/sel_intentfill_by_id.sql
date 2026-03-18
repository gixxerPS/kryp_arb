\set my_id 'mmtq8ukxzillcdnu'
\echo id= :my_id

SELECT
  id,
  ts,
  symbol,
  buy_ex,
  sell_ex,
  ROUND(expected_pnl_quote, 4) AS expected_pnl_quote,
  ROUND(expected_pnl_bps, 4) AS expected_pnl_bps,
  ROUND(buy_quote, 4) AS buy_quote,
  ROUND(sell_quote, 4) AS sell_quote,
  ROUND(target_qty, 4) AS target_qty,
  ROUND(buy_px, 4) AS buy_px,
  ROUND(sell_px, 4) AS sell_px,
  ROUND(buy_px_worst, 4) AS buy_px_worst,
  ROUND(sell_px_worst, 4) AS sell_px_worst
FROM trade_intent
WHERE id = :'my_id';


SELECT
  intent_id,
  ts,
  symbol,
  ROUND(pnl, 4) AS pnl,
  ROUND(buy_price, 4) AS buy_price,
  ROUND(sell_price, 4) AS sell_price,
  ROUND(buy_qty, 4) AS buy_qty,
  ROUND(sell_qty, 4) AS sell_qty,
  ROUND(buy_fee_usd, 4) AS buy_fee_usd,
  ROUND(sell_fee_usd, 4) AS sell_fee_usd
FROM trade_fill
WHERE intent_id = :'my_id';
