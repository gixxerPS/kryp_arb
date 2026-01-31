'use strict';
const { getLogger } = require('../../logger');
const log = getLogger('app').child({ module: 'exchange_state' });

const bus = require('../bus');

let exState; // Singleton

function createExchangeState({ bus, cfg }) {
  if (!bus) throw new Error('exchange_state requires {bus}');
  if (!cfg) throw new Error('exchange_state requires {exchangesCfg}');

  // exchange -> state
  const state = new Map();

  function ensure(exchange) {
    let s = state.get(exchange);
    if (!s) {
      s = {
        exchange,
        wsState: 'UNKNOWN',   // OPEN | CLOSED | UNKNOWN
        anyMsgAt: 0,
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

  function evaluateExchange({ exchange, now = Date.now() }) {
    const cfg = exchangesCfg[exchange];
    if (!cfg) return { ok: false, reason: 'exchange_not_configured' };
    if (!cfg.enabled) return { ok: false, reason: 'exchange_disabled' };

    const s = state.get(exchange);
    if (!s) return { ok: false, reason: 'no_state_yet' };

    if (s.wsState !== 'OPEN') {
      return { ok: false, reason: 'ws_not_open' };
    }

    const anyAgeMs = s.anyMsgAt ? (now - s.anyMsgAt) : Number.POSITIVE_INFINITY;

    if (anyAgeMs > cfg.timeout_no_msg_trade_stop_ms) {
      return {
        ok: false,
        reason: 'no_msgs_trade_stop',
        anyAgeMs,
      };
    }

    if (anyAgeMs > cfg.timeout_no_msg_trade_warn_ms) {
      return {
        ok: true,
        warn: true,
        reason: 'no_msgs_trade_warn',
        anyAgeMs,
      };
    }

    return { ok: true, warn: false, reason: 'ok', anyAgeMs };
  }

  /* =====================
   * Heartbeat / Diagnose
   * ===================== */

  function startHeartbeat(intervalMs = 10_000) {
    const t = setInterval(() => {
      const now = Date.now();
      const snapshot = [];

      for (const [exchange, cfg] of Object.entries(exchangesCfg)) {
        const s = state.get(exchange);
        const anyAgeMs = s?.anyMsgAt ? (now - s.anyMsgAt) : null;

        snapshot.push({
          exchange,
          enabled: cfg.enabled,
          wsState: s?.wsState ?? 'UNKNOWN',
          anyAgeMs,
          counts: s?.counts ?? { anyMsg: 0, reconnects: 0, errors: 0 },
        });
      }

      log.info({ exchanges: snapshot }, 'exchange heartbeat');
    }, intervalMs);

    if (t.unref) t.unref();
  }

  return {
    onWsState,
    onWsMessage,
    onWsReconnect,
    onWsError,
    evaluateExchange,
    startHeartbeat,
    getState: (exchange) => state.get(exchange) || null,
  };
}

/* ========= Singleton Export ========= */

function initExchangeState() {
  if (!exState) {
    exState = createExchangeState();
    exState.startHeartbeat();
  }
  return exState;
}

module.exports = {
  initExchangeState,
  get exState() {
    if (!exState) {
      throw new Error('exState not initialized – call initExchangeState() once at startup');
    }
    return exState;
  },
};

