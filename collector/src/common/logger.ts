import fs from 'node:fs';
import path from 'node:path';

import pino, { type Logger } from 'pino';

import { getLogCfg } from './config';

const cfg = getLogCfg();

function ensureDir(fp: string): void {
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDir(cfg.file.path);

const targets: pino.TransportTargetOptions[] = [
  {
    target: 'pino/file',
    level: 'debug',
    options: {
      destination: cfg.file.path,
      mkdir: true,
    },
  },
];

if (cfg.pretty) {
  targets.push({
    target: 'pino-pretty',
    level: 'debug',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
    },
  });
}

const transport = pino.transport({ targets });

let baseLogger: Logger | null = null;

export function initLogger(): void {
  baseLogger = pino({ level: 'debug', base: null }, transport);
}

function resolveLevel(name: string): string {
  const by = cfg.levelsByName || {};
  if (by[name]) return by[name];

  const parts = String(name).split(':');
  while (parts.length > 1) {
    parts.pop();
    const key = parts.join(':');
    if (by[key]) return by[key];
  }
  return 'info';
}

export function getLogger(name: string): Logger {
  if (!baseLogger) {
    initLogger();
  }
  return (baseLogger as Logger).child({ name }, { level: resolveLevel(name) });
}

const heartbeatLogger = pino(
  {
    level: 'info',
    base: null,
  },
  pino.destination({
    dest: cfg.file.heartbeatpath,
    mkdir: true,
    sync: false,
  })
);

export function getHeartbeatLogger(): Logger {
  return heartbeatLogger;
}
