// bot/src/config.js
const path = require('path');

const { readJson } = require('./util');

function absConfigPath(...parts) {
  return path.join(__dirname, '../../config', ...parts);
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

  const symbolinfoBinance = readJson(absConfigPath('symbolinfo', 'binance.spot.json'));
  const symbolinfoBitget  = readJson(absConfigPath('symbolinfo', 'bitget.spot.json'));
  const symbolinfoGate    = readJson(absConfigPath('symbolinfo', 'gate.spot.json'));

  const symbolInfoByEx = {
    binance: symbolinfoBinance,
    bitget: symbolinfoBitget,
    gate: symbolinfoGate,
  };

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
    symbolInfoByEx
  };
  // console.log(cfg);

  cached = { cfg, exchanges, symbols, log, symbolInfoByEx };
  return cached;
}

// gezielt exportieren, damit Module nicht “alles” brauchen
function getCfg() {
  return loadConfig().cfg;
}

function getExchange(ex) {
  return loadConfig().exchanges[ex];
}

function getLogCfg() {
  return loadConfig().log;
}

function getBotCfg() {
  return loadConfig().cfg.bot;
}

function getSymbolInfoByEx() { 
  return loadConfig().symbolInfoByEx; 
}

// optional für Tests / hot-reload
function resetConfigCache() {
  cached = null;
}

module.exports = {
  loadConfig,
  getCfg,
  getLogCfg,
  resetConfigCache,
  getSymbolInfoByEx,
  getExchange,
  getBotCfg
};

