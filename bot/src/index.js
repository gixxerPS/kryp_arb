const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { loadConfig } = require('./config');

const { initLogger, getLogger } = require('./logger');
initLogger();
const log = getLogger('app');

const startBinanceDepth = require('./collector/binance_depth');
const startGateDepth = require('./collector/gate_depth');
const startBitgetDepth = require('./collector/bitget_depth');

const startStrategy = require('./strategy');
const startPaperExecutor = require('./executor/paper');


function loadJson(fp) {
  const raw = fs.readFileSync(fp, 'utf8');
  return JSON.parse(raw);
}

async function main() {
  const { cfg, fees } = loadConfig();

  log.info({ cfg }, 'starting');

  // collectors (L2 only)
  startBinanceDepth(10, 100);
  //startGateDepth(10, 100);
  //startBitgetDepth(15);

  //// strategy + executor
  //startStrategy(cfg, fees);
  //startPaperExecutor();
}

main().catch((e) => {
  log.error({ err: e }, 'startup error');
  process.exit(1);
});

