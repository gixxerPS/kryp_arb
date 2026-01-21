CREATE TABLE bbo_ticks (
  ts timestamptz NOT NULL,
  exchange text NOT NULL,
  symbol text NOT NULL,
  bid double precision,
  bid_size double precision,
  ask double precision,
  ask_size double precision
);

CREATE INDEX idx_bbo_ticks_ts ON bbo_ticks (ts);
CREATE INDEX idx_bbo_ticks_exchange_ts ON bbo_ticks (exchange, ts);
CREATE INDEX idx_bbo_ticks_symbol_ts ON bbo_ticks (symbol, ts);

-- L2 Orderbuchtiefe (Top-of-Book + aggregierte Tiefe)
-- Eine Zeile pro (Sekunde × Exchange × Symbol)

CREATE TABLE IF NOT EXISTS orderbook_depth (
  ts           TIMESTAMPTZ NOT NULL,  -- Downsample-Zeit (z. B. 1s)
  exchange     TEXT        NOT NULL,  -- 'binance', 'gate', 'bitget'
  symbol       TEXT        NOT NULL,  -- z. B. 'BTCUSDT'

  best_bid     NUMERIC     NOT NULL,  -- L1 Best Bid Preis
  best_ask     NUMERIC     NOT NULL,  -- L1 Best Ask Preis

  bid_qty_l1   NUMERIC     NOT NULL,  -- verfügbare Menge am Best Bid
  ask_qty_l1   NUMERIC     NOT NULL,  -- verfügbare Menge am Best Ask

  bid_qty_l10  NUMERIC     NOT NULL,  -- kumulierte Menge Top-10 Bids
  ask_qty_l10  NUMERIC     NOT NULL,  -- kumulierte Menge Top-10 Asks

  PRIMARY KEY (ts, exchange, symbol)
);

CREATE INDEX IF NOT EXISTS idx_orderbook_depth_lookup
  ON orderbook_depth (symbol, exchange, ts);
