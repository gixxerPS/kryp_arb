CREATE TABLE trade_intent (
  id UUID PRIMARY KEY,
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

  size_quote NUMERIC(18,8) NOT NULL,      -- z.B. 5000 USDT Budget
  target_qty NUMERIC(18,8) NOT NULL,      -- z.B. 100 AXS

  theoretical_buy_px  numeric(18,8) NOT NULL,
  theoretical_sell_px numeric(18,8) NOT NULL,
  meta JSONB
);
CREATE INDEX idx_intent_status_created
ON trade_intent (status, created_at DESC);
CREATE INDEX idx_intent_route_created
ON trade_intent (symbol, buy_ex, sell_ex, created_at DESC);



CREATE TABLE trade_fill (
  id BIGSERIAL PRIMARY KEY,
  intent_id UUID NOT NULL REFERENCES trade_intent(id),

  ts TIMESTAMPTZ NOT NULL,               -- Fill-Zeit (Exchange oder lokal)
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,

  order_id TEXT,                         -- Exchange order id
  trade_id TEXT,                         -- Exchange trade id (fill id)

  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  price NUMERIC(18,12) NOT NULL,
  qty_base NUMERIC(28,12) NOT NULL,
  qty_quote NUMERIC(28,12) NOT NULL,     -- price * qty_base (oder direkt vom exchange)

  fee NUMERIC(28,12) NOT NULL DEFAULT 0,
  fee_ccy TEXT NOT NULL,                 -- USDT/BNB/etc.

  liquidity TEXT,                        -- maker/taker wenn verfügbar
  raw JSONB                               -- original payload (audit/debug)
);

CREATE INDEX idx_fill_intent ON trade_fill(intent_id);
CREATE INDEX idx_fill_exchange_ts ON trade_fill(exchange, ts DESC);
CREATE UNIQUE INDEX uq_fill_dedupe
ON trade_fill(exchange, trade_id)
WHERE trade_id IS NOT NULL;



CREATE TABLE IF NOT EXISTS public.trade_order_pair (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id  uuid        NOT NULL REFERENCES trade_intent(id),
  ts         timestamptz NOT NULL DEFAULT now(),
  symbol     text        NOT NULL,

  buy_ex     text        NOT NULL,
  buy_order_id text,
  buy_status text,
  buy_raw    jsonb,

  sell_ex     text       NOT NULL,
  sell_order_id text,
  sell_status text,
  sell_raw    jsonb,

);

CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_order_pair_intent
  ON public.trade_order_pair(intent_id);

CREATE INDEX IF NOT EXISTS idx_trade_order_pair_ts
  ON public.trade_order_pair(ts DESC);

CREATE INDEX IF NOT EXISTS idx_trade_order_pair_buy
  ON public.trade_order_pair(buy_ex, buy_order_id)
  WHERE buy_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trade_order_pair_sell
  ON public.trade_order_pair(sell_ex, sell_order_id)
  WHERE sell_order_id IS NOT NULL;
