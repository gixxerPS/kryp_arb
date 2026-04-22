const fs = require('fs');
const path = require('path');
const pino = require('pino');

const { getLogCfg } = require('./config');
const cfg = getLogCfg();
const isProduction = process.env.NODE_ENV === 'production';
const fileEnabled = cfg.file_enabled === true;
const prettyEnabled = cfg.pretty === true && !isProduction;
const heartbeatEnabled = cfg.heartbeat_enabled === true;
const noopLogger = {
  info() {},
};

function ensureDir(fp) {
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let transport;
const targets = [];

if (fileEnabled) {
  ensureDir(cfg.file.path);
  targets.push({
    target: 'pino/file',
    level: 'debug',
    options: {
      destination: cfg.file.path,
      mkdir: true,
    },
  });
}

if (prettyEnabled) {
  targets.push({
    target: 'pino-pretty',
    level: 'debug',
    options: {
      translateTime: 'SYS:standard',
      minimumLevel: 'debug'
    },
  });
}

if (targets.length > 0) {
  transport = pino.transport({ targets });
}

let baseLogger;
function initLogger() {
  // base immer auf debug damit childs level selbst steuern koennen
  baseLogger = transport
    ? pino({ level: 'debug', base: null }, transport)
    : pino({ level: 'debug', base: null });
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

  console.log(`logger not found for ${name}. level = ${cfg.level || 'info'}`);
  // 3) default
  return cfg.level || 'info';
}


function getLogger(name) {
  if (!baseLogger) {
    initLogger();
    //throw new Error('logger not initialized');
  }
  return baseLogger.child({ name }, { level: resolveLevel(name) });
}

// Heartbeat file logging is currently disabled by config. Keep the code path
// available for quick diagnostics by setting log.heartbeat_enabled=true.
const heartbeatLogger = heartbeatEnabled
  ? pino({
      level: 'info',
      base: null,                 // kein pid, hostname
    }, pino.destination({
      dest: cfg.file.heartbeatpath,
      mkdir: true,
      sync: false,                // async write!
    }))
  : noopLogger;
function getHeartbeatLogger() {
  return heartbeatLogger;
}

module.exports = { initLogger, getLogger, getHeartbeatLogger};
