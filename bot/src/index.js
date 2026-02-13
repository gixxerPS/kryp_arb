const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getPublicIp } = require('./common/util');
const { loadConfig } = require('./common/config');
const { initLogger, getLogger } = require('./common/logger');
initLogger();
const log = getLogger('app');
const { initExchangeState } = require('./common/exchange_state');
const symbolinfo = require('./common/symbolinfo');

const db = require('./db');

const startBinanceDepth = require('./collector/binance_depth');
const startGateDepth = require('./collector/gate_depth');
const startBitgetDepth = require('./collector/bitget_depth');
const startDbIntentWriter = require('./db/intent_writer');
const startExecutor = require('./executor');
const startStrategy = require('./strategy');
const { initTelegramBot } = require('./ui/telegram_bot');

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
  log.debug({ cfg }, 'starting');
  log.info({  }, 'starting');

  symbolinfo.init({
    symbolsCanon: cfg.bot.symbols,
    exchangesCfg: cfg.exchanges,
    symbolInfoByEx : cfg.symbolInfoByEx,
    log
  });

  log.info({symbolinfo:symbolinfo.getIndex()}, 'symbolinfo Index');

  await verifyPublicIp();

  const pool = db.init();
  await db.ping();

  initExchangeState(cfg); // monitoring, heartbeat ueberwachung und logging der exchange zustaende

  // L2 collectors 
  // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  // nur wenn in config/exchanges.json die exchange enabled ist werden daten gesammelt
  // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  if (cfg.exchanges.binance.enabled) {
    startBinanceDepth(10, 100);
  } else {
    log.warn({exchange:'binance'}, 'exchange disabled');
  }
  if (cfg.exchanges.gate.enabled) {
    startGateDepth(10, 100);
  } else {
    log.warn({exchange:'gate'}, 'exchange disabled');
  }
  if (cfg.exchanges.bitget.enabled) {
    startBitgetDepth(15);
  } else {
    log.warn({exchange:'bitget'}, 'exchange disabled');
  }

  startStrategy(cfg, fees);
  
  startDbIntentWriter(cfg, pool); // datenbank. trade ideen eintragen

  // executor (private exchange APIs: balances, user streams, orders)
  const executor = await startExecutor({ cfg });

  const app = { cfg, executor}; // zentraler app-context für UI und andere Module
  
  if (cfg.ui.telegram_enabled) {
    initTelegramBot(cfg); // TODO: noch in (app) umbauen
  }
}

main().catch((e) => {
  log.error({ err: e }, 'startup error');
  process.exit(1);
});

