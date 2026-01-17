// src/test_binance.js
// einfacher websocket test. ergebnis auf kommandozeile ausgeben
//
const WebSocket = require('ws');
const log = require('./logger');

const URL = 'wss://stream.binance.com:9443/ws/btcusdt@bookTicker';

function start() {
  const ws = new WebSocket(URL);

  ws.on('open', () => {
    log.info('[BINANCE] WS connected');
    log.info(`[BINANCE] URL: ${URL}`);
  });

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      // bookTicker payload: { u, s, b, B, a, A, ... }
      log.info(`[BINANCE] ${data.s} bid=${data.b} | ${data.B} ask=${data.a} | ${data.A}`);
    } catch (err) {
      log.error('[BINANCE] JSON parse error', err);
    }
  });

  ws.on('close', (code, reason) => {
    log.warn(`[BINANCE] WS closed code=${code} reason=${reason ? reason.toString() : ''}`);
  });

  ws.on('error', (err) => {
    log.error('[BINANCE] WS error', err);
  });
}

start();

