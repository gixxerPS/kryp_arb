'use strict';
const { getLogger, getHeartbeatLogger } = require('./logger');
const log = getLogger('app').child({ module: 'exchange_state' });
const hblog = getHeartbeatLogger(); // separater logger mit eigener datei fuer heartbeats

const bus = require('../bus');

const { WS_STATE, EXCHANGE_QUALITY  } = require('./constants');

let exState = null; // Singleton

function createExchangeState(cfg) {
  if (!bus) throw new Error('exchange_state requires {bus}');
  if (!cfg) throw new Error('exchange_state requires {exchangesCfg}');

  const exchangesCfg = cfg.exchanges;
  
  // exchange -> state
  const state = new Map();

  function ensure(exchange) {
    let s = state.get(exchange);
    if (!s) {
      s = {
        exchange,
        enabled: exchangesCfg[exchange]?.enabled ?? true,
        wsState: WS_STATE.UNKNOWN,   // OPEN | CLOSED | UNKNOWN | ERROR
        anyMsgAt: 0,
        anyAgeMs: null,
        exchangeQuality: EXCHANGE_QUALITY.STOP,
        reason: 'no state yet',
        lastEvalAt: 0,
        lastReconnectAt: 0,
        lastErrorAt: 0,
        counts: {
          anyMsg: 0,
          reconnects: 0,
          errors: 0,
        },
      };
      state.set(exchange, s);
    }
    return s;
  }

  /* =====================
   * Hooks für Collector
   * ===================== */

  function onWsState(exchange, wsState) {
    ensure(exchange).wsState = wsState;
  }

  function onWsMessage(exchange) {
    const s = ensure(exchange);
    s.anyMsgAt = Date.now();
    s.counts.anyMsg += 1;
  }

  function onWsReconnect(exchange) {
    const s = ensure(exchange);
    s.lastReconnectAt = Date.now();
    s.counts.reconnects += 1;
  }

  function onWsError(exchange, err) {
    const s = ensure(exchange);
    s.lastErrorAt = Date.now();
    s.counts.errors += 1;
    log.warn({ exchange, err: err?.message || String(err) }, 'ws error (state)');
  }

  /* =====================
   * Abfrage für Strategy
   * ===================== */
  function getExchangeState(exchange) {
    const s = state.get(exchange);
    if (!s) return null;
    return { ...s, counts: { ...s.counts } };
  }

  /* =====================
   * Periodic evaluation
   * ===================== */

  function evaluateAll(now = Date.now()) {
    for (const [exchange, cfg] of Object.entries(exchangesCfg)) {
      const s = ensure(exchange);

      // refresh enabled in case config reload is added later (optional)
      s.enabled = cfg.enabled ?? true;

      s.anyAgeMs = s.anyMsgAt ? (now - s.anyMsgAt) : Number.POSITIVE_INFINITY;
      s.lastEvalAt = now;

      if (!s.enabled) {
        s.exchangeQuality = EXCHANGE_QUALITY.STOP;
        s.reason = 'exchange_disabled';
        continue;
      }
      if (s.wsState !== WS_STATE.OPEN) {
        s.exchangeQuality = EXCHANGE_QUALITY.STOP;
        s.reason = 'ws_not_open';
        continue;
      }
      const warnMs = cfg.timeout_no_msg_trade_warn_ms ?? 8000;
      const stopMs = cfg.timeout_no_msg_trade_stop_ms ?? 20000;

      if (s.anyAgeMs > stopMs) {
        s.exchangeQuality = EXCHANGE_QUALITY.STOP;
        s.reason = 'no_msgs_trade_stop';
        continue;
      }
      if (s.anyAgeMs > warnMs) {
        s.exchangeQuality = EXCHANGE_QUALITY.WARN;
        s.reason = 'no_msgs_trade_warn';
        continue;
      }
      s.exchangeQuality = EXCHANGE_QUALITY.OK;
      s.reason = 'ok. checks passed';
    }
  }

  /* =====================
   * Heartbeat / Diagnose
   * ===================== */

  function startHeartbeat(intervalMs = 5_000) {
    const t = setInterval(() => {
      const now = Date.now();

      evaluateAll(now);

      const snapshot = [];

      for (const [exchange, cfg] of Object.entries(exchangesCfg)) {
        const s = state.get(exchange);
        const anyAgeMs = s?.anyMsgAt ? (now - s.anyMsgAt) : null;

        snapshot.push({
          exchange,
          enabled: cfg.enabled,
          wsState: s?.wsState ?? WS_STATE.UNKNOWN,
          exchangeQuality: s.exchangeQuality,
          anyAgeMs,
          counts: s?.counts ?? { anyMsg: 0, reconnects: 0, errors: 0 },
        });
      }

      hblog.info({ exchanges: snapshot }, 'exchange heartbeat'); // regelmaessige heartbeats in eigene datei
    }, intervalMs);

    if (t.unref) t.unref();
  }

  // get all as snapshot
  function getAllExchangeStates() {
    return Array.from(state.values()).map(s => ({ ...s, counts: { ...s.counts } }));
  }

  evaluateAll(Date.now()); // map direkt beim start erzeugen

  return {
    onWsState,
    onWsMessage,
    onWsReconnect,
    onWsError,
    startHeartbeat,
    getExchangeState,
    getAllExchangeStates // (als array)
  };
}

/* ========= Singleton Export ========= */

function initExchangeState(cfg) {
  if (exState) return exState;
  exState = createExchangeState(cfg);
  exState.startHeartbeat();
  return exState;
}

function getExState() {
  return exState; // kann null sein
}

module.exports = {
  initExchangeState,
  getExState
};

