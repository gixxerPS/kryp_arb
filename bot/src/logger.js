const fs = require('fs');
const path = require('path');
const pino = require('pino');

function loadLogCfg() {
  const fp = path.join(__dirname, '../config/log.json');
  const raw = fs.readFileSync(fp, 'utf8');
  return JSON.parse(raw);
}

const cfg = loadLogCfg();

const transport = cfg.pretty
  ? pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    })
  : undefined;

const baseLogger = pino(
  {
    level: cfg.level || 'info',
  },
  transport,
);

function getLogger(name) {
  return baseLogger.child({ name });
}

module.exports = { getLogger };

