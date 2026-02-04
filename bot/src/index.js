const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { loadConfig } = require('./common/config');

const { initLogger, getLogger } = require('./common/logger');
initLogger();
const log = getLogger('app');

const db = require('./db');

const startBinanceDepth = require('./collector/binance_depth');
const startGateDepth = require('./collector/gate_depth');
const startBitgetDepth = require('./collector/bitget_depth');

const startStrategy = require('./strategy');
//const startPaperExecutor = require('./executor/paper');

const startDbIntentWriter = require('./db/intent_writer');

const { initExchangeState } = require('./common/exchange_state');

const { initTelegramBot } = require('./ui/telegram_bot');

async function main() {
  const { cfg, fees } = loadConfig();

  log.info({ cfg }, 'starting');

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
    log.info({exchange:'binance'}, 'exchange disabled');
  }
  if (cfg.exchanges.gate.enabled) {
    startGateDepth(10, 100);
  } else {
    log.info({exchange:'gate'}, 'exchange disabled');
  }
  if (cfg.exchanges.bitget.enabled) {
    startBitgetDepth(15);
  } else {
    log.info({exchange:'bitget'}, 'exchange disabled');
  }

  // strategy + executor
  startStrategy(cfg, fees);
  //startPaperExecutor();
  
  // datenbank
  startDbIntentWriter(cfg, pool); // trade ideen eintragen

  if (cfg.ui.telegram_enabled) {
    initTelegramBot(cfg);
  }
}

main().catch((e) => {
  log.error({ err: e }, 'startup error');
  process.exit(1);
});

