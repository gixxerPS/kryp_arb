\set my_symbol 'AXSUSDT'
\-- leer lassen fuer alle Exchanges
\set my_exchange ''
\echo symbol= :my_symbol
\echo exchange= :my_exchange

SELECT
  COUNT(*) AS fill_count,
  ROUND(SUM(pnl), 4) AS total_pnl,
  ROUND(SUM(buy_quote), 4) AS total_buy_quote,
  ROUND(SUM(sell_quote), 4) AS total_sell_quote
FROM trade_fill
WHERE symbol = :'my_symbol'
  AND (
    :'my_exchange' = ''
    OR buy_ex = :'my_exchange'
    OR sell_ex = :'my_exchange'
  );

SELECT
  intent_id,
  ts,
  symbol,
  buy_ex,
  sell_ex,
  ROUND(pnl, 4) AS pnl,
  ROUND(buy_price, 4) AS buy_price,
  ROUND(sell_price, 4) AS sell_price,
  ROUND(buy_qty, 4) AS buy_qty,
  ROUND(sell_qty, 4) AS sell_qty,
  ROUND(buy_quote, 4) AS buy_quote,
  ROUND(sell_quote, 4) AS sell_quote,
  ROUND(buy_fee_usd, 4) AS buy_fee_usd,
  ROUND(sell_fee_usd, 4) AS sell_fee_usd
FROM trade_fill
WHERE symbol = :'my_symbol'
  AND (
    :'my_exchange' = ''
    OR buy_ex = :'my_exchange'
    OR sell_ex = :'my_exchange'
  )
ORDER BY ts DESC;
