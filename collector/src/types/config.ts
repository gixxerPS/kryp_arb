import type { ExchangesCfg, SymbolInfoByEx } from './symbolinfo';
import type { ExchangeId } from './common';

export interface BotCfg {
  strategy: string;
  throttle_ms: number;
  intent_time_to_live_ms: number;
  cooldown_s: number;
  raw_spread_buffer_pct: number;
  slippage_pct: number;
  q_min_usdt: number;
  q_max_usdt: number;
  execution_symbols: string[];
  execution_exchanges: Array<'binance' | 'gate' | 'bitget'>;
}

export interface AppCfg {
  name?: string;
  [k: string]: unknown;
}

export interface DbCfg {
  flushIntervalMs?: number;
  maxBatch?: number;
  [k: string]: unknown;
}

export interface LogCfg {
  pretty?: boolean;
  file: {
    path: string;
    heartbeatpath: string;
  };
  levelsByName?: Record<string, string>;
}

export interface AppConfig {
  app: AppCfg;
  bot: BotCfg;
  symbols: string[];
  exchanges: ExchangesCfg;
  enabledExchanges: ExchangeId[];
  db: DbCfg;
  log: LogCfg;
  symbolInfoByEx: SymbolInfoByEx;
}
