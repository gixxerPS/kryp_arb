\echo '================================='
\echo '== BBO / Tabelle: bbo_ticks    =='
\echo '================================='

\echo '== letzte 5 Minuten'
SELECT exchange, symbol, count(*) AS n
FROM bbo_ticks
WHERE ts > now() - interval '5 minutes'
GROUP BY 1,2
ORDER BY n DESC;

\echo '== letzte Einträge'
\set exch 'binance'
\echo 'Exchange =' :exch
SELECT *
FROM bbo_ticks
WHERE exchange=:'exch'
ORDER BY ts DESC
LIMIT 10;

\echo '== Zeitspanne prüfen'
\set exch 'gate'
\echo 'Exchange =' :exch
SELECT 
  min(ts) AS first_ts,
  max(ts) AS last_ts,
  count(*) AS total
FROM bbo_ticks
WHERE exchange=:'exch';

\echo '================================='
\echo '== Orderbuchtiefe / Tabelle: orderbook_depth =='
\echo '================================='
SELECT *
FROM orderbook_depth
ORDER BY ts DESC
LIMIT 10;
