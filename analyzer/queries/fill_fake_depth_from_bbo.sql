-- Fill synthetic L2 depth for exchanges that do not have real depth yet.
-- Uses the same 2-second binning as sim_trades.js.

INSERT INTO orderbook_depth (
  ts,
  exchange,
  symbol,
  best_bid,
  best_ask,
  bid_qty_l1,
  ask_qty_l1,
  bid_qty_l10,
  ask_qty_l10
)
SELECT
  to_timestamp(floor(extract(epoch FROM ts) / 2) * 2) AS t,
  exchange,
  symbol,
  bid  AS best_bid,
  ask  AS best_ask,
  1000000::numeric AS bid_qty_l1,
  1000000::numeric AS ask_qty_l1,
  1000000::numeric AS bid_qty_l10,
  1000000::numeric AS ask_qty_l10
FROM bbo_ticks
WHERE ts > now() - interval '24 hours'
  AND exchange IN ('gate', 'bitget')
ON CONFLICT (ts, exchange, symbol) DO NOTHING;

