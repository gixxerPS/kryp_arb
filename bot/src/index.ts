import path from 'path';

require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

import { getPublicIp } from './common/util';
import { loadConfig } from './common/config';
import { initLogger, getLogger } from './common/logger';
initLogger();
const log = getLogger('app');
import { initExchangeState } from './common/exchange_state';
import { loadPersistent, savePersistent } from './common/persistent';
import { init as initSymbolInfo,
  getIndex, 
  getReverseIndex
 } from './common/symbolinfo';
import { initSymbolInfoPrice } from './common/symbolinfo_price';

import { init as initDb, ping as pingDb } from './db';

import startBinanceDepth from './collector/binance_depth';
import startGateDepth from './collector/gate_depth';
import startBitgetDepth from './collector/bitget_depth';
import startMexcDepth from './collector/mexc_depth';
import startExecutor from './executor';
import startStrategy from './strategy';
import { initTelegramBot } from './ui/telegram_bot';
import type { PersistentStore } from './types/persistent';

async function verifyPublicIp() {
  const expectedIps = process.env.EXPECTED_PUBLIC_IPS;
  if (!expectedIps) {
    throw new Error('EXPECTED_PUBLIC_IPS not set in .env');
  }
  const allowed = expectedIps.split(',').map(s => s.trim());
  const actualIp = await getPublicIp(); // fetched via 'https://api.ipify.org'
  log.debug({ip:actualIp}, 'public ip');
  if (!allowed.includes(actualIp)) {
    throw new Error(
      `actual public IP not included in expected: expected=${expectedIps} actual=${actualIp}`
    );
  }
}

async function main() {
  const { cfg } = loadConfig();
  // log.debug({ cfg }, 'startup config');
  log.info({  }, 'starting');
  await verifyPublicIp();

  const loadedPersistent = await loadPersistent({ cfg, log });
  const persistentStore: PersistentStore = loadedPersistent ?? {};

  // u.a. symbolinfo je exchange {AXS_USDT:{binance:{...}, gate:{...}, bitget:{...}}}
  // und wieder reverse mapping je symbol und exchange
  initSymbolInfo({
    symbolsCanon: cfg.symbols,
    exchangesCfg: cfg.exchanges,
    symbolInfoByEx : cfg.symbolInfoByEx,
  });
  // log.info({symInfoIdx:getIndex(), symInfoRevIdx:getReverseIndex()});

  await initSymbolInfoPrice();

  initDb(cfg);
  await pingDb();

  initExchangeState(cfg); // monitoring, heartbeat ueberwachung und logging der exchange zustaende

  // L2 collectors 
  if (cfg.exchanges.binance.enabled) {
    startBinanceDepth();
  } else {
    log.warn({exchange:'binance'}, 'exchange disabled. no data collection');
  }
  if (cfg.exchanges.gate.enabled) {
    startGateDepth();
  } else {
    log.warn({exchange:'gate'}, 'exchange disabled. no data collection');
  }
  if (cfg.exchanges.bitget.enabled) {
    startBitgetDepth();
  } else {
    log.warn({exchange:'bitget'}, 'exchange disabled. no data collection');
  }
  if (cfg.exchanges.mexc?.enabled) {
    startMexcDepth();
  } else {
    log.warn({ exchange: 'mexc' }, 'exchange disabled. no data collection');
  }

  const strategy = startStrategy(cfg);
  
  // executor (private exchange APIs: balances, user streams, orders)
  const executor = await startExecutor({
    cfg,
    restoredRuntimeState: persistentStore.runtimeState ?? null,
  });

  const app = { cfg, executor, strategy }; // zentraler app-context für UI und andere Module
  
  if (cfg.ui.telegram_enabled) {
    initTelegramBot({cfg, app}); // TODO: noch in (app) umbauen
  }

  let isShuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    try {
      const nextPersistent: PersistentStore = {
        ...persistentStore,
        runtimeState: executor.getRuntimeState(),
      };
      await savePersistent(nextPersistent);
      log.info({ signal }, 'persistent state saved');
    } catch (err) {
      log.error({ err, signal }, 'failed to save persistent state');
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      log.error({ err }, 'shutdown SIGINT failed');
      process.exit(1);
    });
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      log.error({ err }, 'shutdown SIGTERM failed');
      process.exit(1);
    });
  });
}

main().catch((e) => {
  log.error({ err: e }, 'startup error');
  process.exit(1);
});
