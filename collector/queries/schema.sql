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

