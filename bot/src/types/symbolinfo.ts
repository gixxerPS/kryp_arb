import type { ExchangeId, } from './common';

export interface SubscriptionCfg {
  levels: number;
  updateMs?: number; // binance/gate
}

export interface ExchangeCfg {
  enabled?: boolean;
  quote_map?: Record<string, string>;
  subscription: SubscriptionCfg;

  maker_fee_pct?: number;
  taker_fee_pct?: number;
  timeout_no_msg_trade_warn_ms?: number;
  timeout_no_msg_trade_stop_ms?: number;
}

export type ExchangesCfg = Partial<Record<ExchangeId, ExchangeCfg>>;

export interface RawSymbolInfo {
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
  status?: string;

  enabled?: boolean;

  pricePrecision?: number;
  qtyPrecision?: number;

  priceTick?: string | number;
  qtyStep?: string | number;

  minQty?: number;
  maxQty?: number;
  minNotional?: number;
}

export interface StepMeta {
  decimals: number;
  factor: number;
  stepInt: number;
}

export interface CompiledRules {
  enabled: boolean;
  qtyStep: number;
  qty: StepMeta;       // integer meta für schnelle floor-berechnung
  priceTick: number;
  minQty: number;
  maxQty: number;
  minNotional: number;
}

export interface CanonPair {
  base: string;
  quote: string;
}

export interface ExSymbolInfo {
  enabled: boolean;
  base: string;
  quote: string;
  mdKey: string;
  orderKey: string;
  rules: CompiledRules | null;
  extra: Record<string, unknown>;
}

export type SymbolInfoRow = { canon: CanonPair } & Partial<Record<ExchangeId, ExSymbolInfo>>;

export type SymbolIndex = Record<string, SymbolInfoRow>;

export interface ReverseIndexEntry {
  canon: string;
}

export interface ReverseIndexPerEx {
  mdKey: Record<string, ReverseIndexEntry>;
  orderKey: Record<string, ReverseIndexEntry>;
}

export type ReverseIndex = Partial<Record<ExchangeId, ReverseIndexPerEx>>;

export interface SymbolInfoByEx {
  [ex: string]: {
    meta?: unknown;
    symbols?: Record<string, RawSymbolInfo>;
  };
}

export interface InitArgs {
  symbolsCanon: string[];
  exchangesCfg: ExchangesCfg;
  symbolInfoByEx: SymbolInfoByEx;
  log?: {
    warn?: (obj: any, msg?: string) => void;
  };
}
