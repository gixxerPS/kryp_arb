const fs = require('fs');
const path = require('path');
const log4js = require('log4js');

function loadConfig() {
  const p = path.join(__dirname, '../config/log.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const cfg = loadConfig();
const logDir = path.join(__dirname, '..', cfg.logDir || 'logs');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const appenders = {};
const enabledAppenders = [];

if (cfg.appenders?.console?.enabled) {
  appenders.out = {
    type: 'stdout'
  };
  enabledAppenders.push('out');
}

if (cfg.appenders?.file?.enabled) {
  appenders.file = {
    type: 'file',
    filename: path.join(logDir, cfg.appenders.file.filename || 'collector.log'),
    maxLogSize: cfg.appenders.file.maxLogSize || 10 * 1024 * 1024,
    backups: cfg.appenders.file.backups || 3,
    compress: !!cfg.appenders.file.compress,
    layout: { type: 'pattern', pattern: '%d [%p] %c - %m' },
  };
  enabledAppenders.push('file');
}

if (enabledAppenders.length === 0) {
  appenders.out = {
    type: 'stdout',
    layout: { type: 'pattern', pattern: '%d [%p] %c - %m' },
  };
  enabledAppenders.push('out');
}

const categories = {};
const catCfg = cfg.categories || {};
const defaultLevel = catCfg.default?.level || 'info';

categories.default = {
  appenders: enabledAppenders,
  level: defaultLevel,
};

for (const [name, c] of Object.entries(catCfg)) {
  if (name === 'default') continue;

  categories[name] = {
    appenders: c.appenders && Array.isArray(c.appenders) && c.appenders.length > 0
      ? c.appenders
      : enabledAppenders,
    level: c.level || defaultLevel,
  };
}

log4js.configure({ appenders, categories });

function getLogger(name) {
  return log4js.getLogger(name);
}

module.exports = { getLogger };

