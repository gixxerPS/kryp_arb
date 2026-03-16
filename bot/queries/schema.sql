CREATE TABLE IF NOT EXISTS public.trade_intent (
  id VARCHAR(32) PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,               -- Intent-Zeit aus der App
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  symbol TEXT NOT NULL,
  buy_ex TEXT NOT NULL,
  sell_ex TEXT NOT NULL,
  strategy TEXT NOT NULL,

  status TEXT NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,

  expected_pnl_quote NUMERIC(18,8) NOT NULL,
  expected_pnl_bps   NUMERIC(10,4) NOT NULL,

  buy_quote NUMERIC(18,8) NOT NULL,      -- z.B. 5000 USDT Budget
  sell_quote NUMERIC(18,8) NOT NULL,      -- z.B. 5000 USDT Budget
  target_qty NUMERIC(18,8) NOT NULL,      -- z.B. 100 AXS

  buy_px        numeric(18,8) NOT NULL,
  sell_px       numeric(18,8) NOT NULL,
  buy_px_worst  numeric(18,8) NOT NULL,
  sell_px_worst numeric(18,8) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intent_status_created
ON trade_intent (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intent_route_created
ON trade_intent (symbol, buy_ex, sell_ex, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intent_status_ts
ON trade_intent (status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_intent_route_ts
ON trade_intent (symbol, buy_ex, sell_ex, ts DESC);


CREATE TABLE IF NOT EXISTS public.trade_fill (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id VARCHAR(32) NOT NULL REFERENCES trade_intent(id),

  ts TIMESTAMPTZ NOT NULL,               -- Fill-Zeit (Exchange oder lokal)
  symbol TEXT NOT NULL,

  buy_ex     text        NOT NULL,
  buy_order_id text,
  buy_order_ts TIMESTAMPTZ,
  buy_status text,
  buy_price  NUMERIC(18,12) NOT NULL,
  buy_qty    NUMERIC(28,12) NOT NULL,
  buy_quote  NUMERIC(18,8) NOT NULL, 
  buy_fee_amount NUMERIC(28,12) NOT NULL DEFAULT 0,
  buy_fee_ccy TEXT NOT NULL,                 -- USDT/BNB/etc.
  buy_fee_usd NUMERIC(28,12) NOT NULL DEFAULT 0,
  
  sell_ex     text       NOT NULL,
  sell_order_id text,
  sell_order_ts TIMESTAMPTZ,
  sell_status text,
  sell_price  NUMERIC(18,12) NOT NULL, -- avg wenn ueber mehrere levels gefillt
  sell_qty    NUMERIC(28,12) NOT NULL,
  sell_quote  NUMERIC(18,8) NOT NULL, 
  sell_fee_amount NUMERIC(28,12) NOT NULL DEFAULT 0,
  sell_fee_ccy TEXT NOT NULL,                 -- USDT/BNB/etc.
  sell_fee_usd NUMERIC(28,12) NOT NULL DEFAULT 0,
  
  pnl NUMERIC(18,12) NOT NULL -- min(sellQty, buyQty)*price_vwap - buy_fess - sell_fees
);

CREATE INDEX IF NOT EXISTS idx_fill_intent ON trade_fill(intent_id);
CREATE INDEX IF NOT EXISTS idx_fill_symbol_ts ON trade_fill(symbol, ts DESC);
CREATE INDEX IF NOT EXISTS idx_trade_fill_ts_desc ON public.trade_fill(ts DESC);
