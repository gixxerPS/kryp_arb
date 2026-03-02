import path from 'path';

require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

import { getPublicIp } from './common/util';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { loadConfig } from './common/config';
import { initLogger, getLogger } from './common/logger';
initLogger();
const log = getLogger('app');
import { initExchangeState } from './common/exchange_state';
import * as symbolinfo from './common/symbolinfo';

import { init as initDb, ping as pingDb } from './db';

import startBinanceDepth from './collector/binance_depth';
import startGateDepth from './collector/gate_depth';
import startBitgetDepth from './collector/bitget_depth';
import startExecutor from './executor';
import startStrategy from './strategy';
import { initTelegramBot } from './ui/telegram_bot';

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
  const { cfg, fees } = loadConfig();
  // log.debug({ cfg }, 'startup config');
  log.info({  }, 'starting');

  // u.a. symbolinfo je exchange {AXS_USDT:{binance:{...}, gate:{...}, bitget:{...}}}
  // und wieder reverse mapping je symbol und exchange
  symbolinfo.init({
    symbolsCanon: cfg.symbols,
    exchangesCfg: cfg.exchanges,
    symbolInfoByEx : cfg.symbolInfoByEx,
    log
  });

  // log.info({symInfoIdx:symbolinfo.getIndex(), symInfoRevIdx:symbolinfo.getReverseIndex()});

  await verifyPublicIp();

  initDb(cfg);
  await pingDb();

  initExchangeState(cfg); // monitoring, heartbeat ueberwachung und logging der exchange zustaende

  // L2 collectors 
  // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  // nur wenn in config/exchanges.json die exchange enabled ist werden daten gesammelt
  // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
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

  startStrategy(cfg);
  
  // executor (private exchange APIs: balances, user streams, orders)
  const executor = await startExecutor({ cfg });

  const app = { cfg, executor}; // zentraler app-context für UI und andere Module
  
  if (cfg.ui.telegram_enabled) {
    initTelegramBot({cfg, app}); // TODO: noch in (app) umbauen
  }
}

main().catch((e) => {
  log.error({ err: e }, 'startup error');
  process.exit(1);
});
