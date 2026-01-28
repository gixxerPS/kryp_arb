const fs = require('fs');
const path = require('path');
const pino = require('pino');

const { getLogCfg } = require('./config');
const cfg = getLogCfg();

function ensureDir(fp) {
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ensure log dir exists
let transport;
if (cfg.file?.path) {
  ensureDir(cfg.file.path);

  const targets = [];

  // 1) File target (immer JSON)
  targets.push({
    target: 'pino/file',
    options: {
      destination: cfg.file.path,
      mkdir: true,
    },
  });
  // test : menschenlesbare datei -> spaeter loeschen
  targets.push({
    target: 'pino-pretty',
    options: {
      destination: 'logs/pretty.log',
      mkdir: true,translateTime: 'SYS:standard' 
    },
  });

  // 2) Optional pretty console
  if (cfg.pretty) {
    targets.push({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    });
  }

  transport = pino.transport({ targets });
} else if (cfg.pretty) {
  // Nur Console (Dev)
  transport = pino.transport({
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard' },
  });
}

let baseLogger;
function initLogger() {
  baseLogger = pino({ level: cfg.level || 'info' });
}

function resolveLevel(name) {
  const by = cfg.levelsByName || {};

  // 1) exact match
  if (by[name]) {
    //console.log(`exact logger found for ${name}. level = ${by[name]}`);
    return by[name];
  }

  // 2) hierarchical fallback: "collector:binance_depth" -> "collector"
  const parts = String(name).split(':');
  while (parts.length > 1) {
    parts.pop();
    const k = parts.join(':');
    if (by[k]) {
      //console.log(`sub logger found for ${name}. level = ${by[k]}`);
      return by[k];
    }
  }

  //console.log(`logger not found for ${name}. level = ${cfg.level || 'info'}`);
  // 3) default
  return cfg.level || 'info';
}


function getLogger(name) {
  if (!baseLogger) throw new Error('logger not initialized');
  return baseLogger.child({ name }, { level: resolveLevel(name) });
}

module.exports = { initLogger, getLogger };

