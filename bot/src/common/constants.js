'use strict';

const WS_STATE = Object.freeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  CONNECTING: 'CONNECTING',
  ERROR: 'ERROR',
});

const EXCHANGE_QUALITY = Object.freeze({
  OK: 'OK',
  WARN: 'WARN',
  STOP: 'STOP',
});

module.exports = {
  WS_STATE,
  EXCHANGE_QUALITY,
};

