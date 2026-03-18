import path from 'node:path';

import dns from 'node:dns';
import dotenv from 'dotenv';

import { loadConfig } from './common/config';
import { initExchangeState } from './common/exchange_state';
import { initLogger, getLogger } from './common/logger';
import { init as initSymbolInfo } from './common/symbolinfo';
import { init as initDb, ping as pingDb } from './db';
import startStrategy from './strategy';
import startBinanceDepth from './collector/binance_depth';
import startGateDepth from './collector/gate_depth';
import startBitgetDepth from './collector/bitget_depth';
import startMexcDepth from './collector/mexc_depth';

dotenv.config({ path: path.join(__dirname, '../../../.env') });
dns.setDefaultResultOrder('ipv4first');

initLogger();
const log = getLogger('app');

async function main(): Promise<void> {
  const { cfg } = loadConfig();

  log.info({}, 'starting');

  initSymbolInfo({
    symbolsCanon: cfg.symbols,
    exchangesCfg: cfg.exchanges,
    symbolInfoByEx: cfg.symbolInfoByEx,
  });

  initDb(cfg);
  await pingDb();
  initExchangeState(cfg);

  if (cfg.exchanges.binance?.enabled) {
    startBinanceDepth();
  } else {
    log.warn({ exchange: 'binance' }, 'exchange disabled. no data collection');
  }

  if (cfg.exchanges.gate?.enabled) {
    startGateDepth();
  } else {
    log.warn({ exchange: 'gate' }, 'exchange disabled. no data collection');
  }

  if (cfg.exchanges.bitget?.enabled) {
    startBitgetDepth();
  } else {
    log.warn({ exchange: 'bitget' }, 'exchange disabled. no data collection');
  }

  if (cfg.exchanges.mexc?.enabled) {
    startMexcDepth();
  } else {
    log.warn({ exchange: 'mexc' }, 'exchange disabled. no data collection');
  }

  startStrategy(cfg);
}

void main().catch((err) => {
  log.error({ err }, 'startup error');
  process.exit(1);
});
