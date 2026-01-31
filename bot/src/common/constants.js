'use strict';

const WS_STATE = Object.freeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  CONNECTING: 'CONNECTING',
  UNKNOWN: 'UNKNOWN',
  ERROR: 'ERROR',
});

const EXCHANGE_QUALITY = Object.freeze({
  OK: 'OK', // frische stream nachrichten und ws open
  WARN: 'WARN', // keine frischen stream nachrichten aber ws open -> lieber preisdaten pruefen unmittelbar vor trade
  STOP: 'STOP', // stream nachrichten zu alt oder ws close
});

module.exports = {
  WS_STATE,
  EXCHANGE_QUALITY,
};

