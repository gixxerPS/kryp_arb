import type { ExchangesCfg, SymbolInfoByEx } from './symbolinfo';
import type { ExchangeId } from './common';

export interface BotCfg {
    strategy: string;
  
    throttle_ms: number;
    intent_time_to_live_ms: number;
    cooldown_ms: number;
  
    raw_spread_buffer_pct: number;
    slippage_pct: number;
  
    q_min_usdt: number;
    q_max_usdt: number;
    balance_minimum_usdt: number;
  
    auto_fix_failed_orders: boolean;
  
    execution_symbols: string[];
    execution_exchanges: Array<'binance' | 'gate' | 'bitget'>;
  }

export interface AppCfg {
  persistent_path: string;
  [k: string]: unknown;
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
  app: AppCfg;
  bot: BotCfg;
  symbols: string[];
  exchanges: ExchangesCfg;
  enabledExchanges: ExchangeId[];
  db: DbCfg;
  ui: UiCfg;
  symbolInfoByEx: SymbolInfoByEx;
  log?: LogCfg;
}
