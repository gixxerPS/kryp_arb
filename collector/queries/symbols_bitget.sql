SELECT symbol, count(*) AS n
FROM bbo_ticks
WHERE exchange='bitget'
  AND ts > now() - interval '5 minutes'
GROUP BY 1
ORDER BY n DESC;

