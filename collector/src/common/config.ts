import path from 'node:path';

import { readJson } from './util';

import type { AppCfg, AppConfig, BotCfg, DbCfg, LogCfg } from '../types/config';
import type { ExchangeId } from '../types/common';
import type { ExchangesCfg, SymbolInfoExchangeFile } from '../types/symbolinfo';

type SymbolsCfg = {
  symbols?: string[];
};

type LoadedConfig = {
  cfg: AppConfig;
  app: AppCfg;
  bot: BotCfg;
  exchanges: ExchangesCfg;
  db: DbCfg;
  log: LogCfg;
  symbolInfoByEx: AppConfig['symbolInfoByEx'];
};

let cached: LoadedConfig | null = null;

function absConfigPath(...parts: string[]): string {
  return path.resolve(process.cwd(), 'config', ...parts);
}

export function loadConfig(): LoadedConfig {
  if (cached) return cached;

  const app = readJson<AppCfg>(absConfigPath('app.json'));
  const bot = readJson<BotCfg>(absConfigPath('bot.json'));
  const exchanges = readJson<ExchangesCfg>(absConfigPath('exchanges.json'));
  const symbols = readJson<SymbolsCfg>(absConfigPath('symbols.json')).symbols ?? [];
  const db = readJson<DbCfg>(absConfigPath('db.json'));
  const log = readJson<LogCfg>(absConfigPath('log.json'));
  const enabledExchanges = (['binance', 'gate', 'bitget'] as ExchangeId[])
    .filter((ex) => exchanges[ex]?.enabled);

  const symbolInfoByEx = {
    binance: readJson<SymbolInfoExchangeFile>(absConfigPath('symbolinfo', 'binance.spot.json')),
    bitget: readJson<SymbolInfoExchangeFile>(absConfigPath('symbolinfo', 'bitget.spot.json')),
    gate: readJson<SymbolInfoExchangeFile>(absConfigPath('symbolinfo', 'gate.spot.json')),
  };

  const cfg: AppConfig = {
    app,
    bot,
    symbols,
    exchanges,
    enabledExchanges,
    db,
    log,
    symbolInfoByEx,
  };

  cached = { cfg, app, bot, exchanges, db, log, symbolInfoByEx };
  return cached;
}

export function getCfg(): AppConfig {
  return loadConfig().cfg;
}

export function getLogCfg(): LogCfg {
  return loadConfig().log;
}

export function resetConfigCache(): void {
  cached = null;
}
