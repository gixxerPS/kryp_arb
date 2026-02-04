// bot/src/config.js
const fs = require('fs');
const path = require('path');

function readJson(fp) {
  const raw = fs.readFileSync(fp, 'utf8');
  return JSON.parse(raw);
}

function absConfigPath(rel) {
  return path.join(__dirname, '../../config', rel);
}

let cached = null;

function loadConfig() {
  if (cached) return cached;

  const bot = readJson(absConfigPath('bot.json'));
  const exchanges = readJson(absConfigPath('exchanges.json'));
  const symbolsFile = readJson(absConfigPath('symbols.json'));
  const log = readJson(absConfigPath('log.json'));
  const db = readJson(absConfigPath('db.json'));
  const ui = readJson(absConfigPath('ui.json'));
  const symbols = symbolsFile.symbols || [];

  // exchanges list: bot.json exchanges fallback alle keys aus exchanges.json
  const exchangeList = Array.isArray(bot.exchanges) && bot.exchanges.length > 0
    ? bot.exchanges
    : Object.keys(exchanges || {});

  const cfg = {
    bot,
    symbols,
    exchanges,
    db,
    ui,
  };
  //console.log(cfg);

  cached = { cfg, fees: exchanges, symbolsFile, log };
  return cached;
}

// gezielt exportieren, damit Module nicht “alles” brauchen
function getCfg() {
  return loadConfig().cfg;
}

function getFees() {
  return loadConfig().fees;
}

function getLogCfg() {
  return loadConfig().log;
}

// optional für Tests / hot-reload
function resetConfigCache() {
  cached = null;
}

module.exports = {
  loadConfig,
  getCfg,
  getFees,
  getLogCfg,
  resetConfigCache,
};

