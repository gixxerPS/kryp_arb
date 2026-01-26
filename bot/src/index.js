const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getLogger } = require('./logger');

const startBinanceDepth = require('./collector/binance_depth');
const startGateDepth = require('./collector/gate_depth');
const startBitgetDepth = require('./collector/bitget_depth');

const startStrategy = require('./strategy');
const startPaperExecutor = require('./executor/paper');

const log = getLogger('app');

function loadJson(fp) {
  const raw = fs.readFileSync(fp, 'utf8');
  return JSON.parse(raw);
}

function loadConfig() {
  const cfg = loadJson(path.join(__dirname, '../config/bot.json'));
  const fees = loadJson(path.join(__dirname, '../config/exchanges.json'));
  return { cfg, fees };
}

async function main() {
  const { cfg, fees } = loadConfig();

  log.info({ cfg }, 'starting');

  // collectors (L2 only)
  startBinanceDepth(cfg.symbols, 10, 100);
  startGateDepth(cfg.symbols, 10, 100);
  startBitgetDepth(cfg.symbols, 15);

  // strategy + executor
  startStrategy(cfg, fees);
  startPaperExecutor();
}

main().catch((e) => {
  log.error({ err: e }, 'startup error');
  process.exit(1);
});

