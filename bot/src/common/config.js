// bot/src/config.js
const path = require('path');

const { readJson } = require('./util');

function absConfigPath(...parts) {
  return path.resolve(process.cwd(), 'config', ...parts);
}

let cached = null;

function loadConfig() {
  if (cached) return cached;

  const app = readJson(absConfigPath('app.json'));
  const bot = readJson(absConfigPath('bot.json'));
  const exchanges = readJson(absConfigPath('exchanges.json'));
  const symbolsFile = readJson(absConfigPath('symbols.json'));
  const log = readJson(absConfigPath('log.json'));
  const db = readJson(absConfigPath('db.json'));
  const ui = readJson(absConfigPath('ui.json'));
  const symbols = symbolsFile.symbols || [];
  const enabledExchanges = ['binance', 'gate', 'bitget']
    .filter((ex) => exchanges?.[ex]?.enabled);

  const symbolinfoBinance = readJson(absConfigPath('symbolinfo', 'binance.spot.json'));
  const symbolinfoBitget  = readJson(absConfigPath('symbolinfo', 'bitget.spot.json'));
  const symbolinfoGate    = readJson(absConfigPath('symbolinfo', 'gate.spot.json'));

  const symbolInfoByEx = {
    binance: symbolinfoBinance,
    bitget: symbolinfoBitget,
    gate: symbolinfoGate,
  };

  const cfg = {
    app,
    bot,
    symbols,
    exchanges,
    enabledExchanges,
    db,
    ui,
    symbolInfoByEx
  };
  // console.log(cfg);

  cached = { cfg, exchanges, symbols, log, symbolInfoByEx, app };
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

function getAppCfg() {
  return loadConfig().cfg.app;
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
  getBotCfg,
  getAppCfg
};
