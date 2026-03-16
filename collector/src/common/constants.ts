export const WS_STATE = Object.freeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  CONNECTING: 'CONNECTING',
  UNKNOWN: 'UNKNOWN',
  ERROR: 'ERROR',
} as const);

export const EXCHANGE_QUALITY = Object.freeze({
  OK: 'OK',
  WARN: 'WARN',
  STOP: 'STOP',
} as const);
