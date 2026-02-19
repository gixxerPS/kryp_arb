import type { ExchangesCfg, SymbolInfoByEx } from './symbolinfo';

export interface BotCfg {
    strategy: string;
  
    throttle_ms: number;
    intent_time_to_live_ms: number;
    cooldown_s: number;
  
    raw_spread_buffer_pct: number;
    slippage_pct: number;
  
    q_min_usdt: number;
    q_max_usdt: number;
    balance_minimum_usdt: number;
  
    auto_fix_failed_orders: boolean;
  
    symbols: string[];
    exchanges: Array<'binance' | 'gate' | 'bitget'>;
  }

export interface DbCfg {
  [k: string]: unknown;
}

export interface UiCfg {
  [k: string]: unknown;
}

export interface LogCfg {
  [k: string]: unknown;
}

export interface AppConfig {
  bot: BotCfg;
  symbols: { symbols: string[] } | { symbols: string[]; [k: string]: unknown };
  exchanges: ExchangesCfg;
  db: DbCfg;
  ui: UiCfg;
  symbolInfoByEx: SymbolInfoByEx;
  log?: LogCfg;
}