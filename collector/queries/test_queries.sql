-- letzte 5 Minuten
SELECT exchange, symbol, count(*) AS n
FROM bbo_ticks
WHERE ts > now() - interval '5 minutes'
GROUP BY 1,2
ORDER BY n DESC;

-- letzte Einträge
SELECT *
FROM bbo_ticks
WHERE exchange='binance'
ORDER BY ts DESC
LIMIT 10;

-- Zeitspanne prüfen
SELECT 
  min(ts) AS first_ts,
  max(ts) AS last_ts,
  count(*) AS total
FROM bbo_ticks
WHERE exchange='binance';

