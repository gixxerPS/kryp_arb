\echo '================================='
\echo '== Trade Intents / Tabelle: trade_intent =='
\echo '================================='

\echo '== letzte 5 Minuten'
SELECT buy_ex, sell_ex, symbol, count(*) AS n
FROM trade_intent
WHERE ts > now() - interval '5 minutes'
GROUP BY 1,2,3
ORDER BY n DESC;

\echo '== letzte Einträge'
\set exch 'binance'
\echo 'Exchange beteiligt =' :exch
SELECT *
FROM trade_intent
WHERE buy_ex = :'exch'
   OR sell_ex = :'exch'
ORDER BY ts DESC
LIMIT 10;

\echo '== Zeitspanne prüfen'
\set exch 'gate'
\echo 'Exchange beteiligt =' :exch
SELECT 
  min(ts) AS first_ts,
  max(ts) AS last_ts,
  count(*) AS total
FROM trade_intent
WHERE buy_ex = :'exch'
   OR sell_ex = :'exch';

\echo '================================='
\echo '== Orderbuchtiefe / Tabelle: orderbook_depth =='
\echo '================================='
SELECT *
FROM orderbook_depth
ORDER BY ts DESC
LIMIT 10;
