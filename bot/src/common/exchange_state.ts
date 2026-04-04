import bus from '../bus';
import { EXCHANGE_QUALITY, WS_STATE } from './constants';
import { getHeartbeatLogger, getLogger } from './logger';

import type { AppConfig } from '../types/config';
import type { ExchangeId } from '../types/common';

const log = getLogger('app').child({ module: 'exchange_state' });
const hblog = getHeartbeatLogger();

type ExchangeState = {
  exchange: string;
  enabled: boolean;
  wsState: string;
  anyMsgAt: number;
  anyAgeMs: number | null;
  exchangeQuality: string;
  reason: string;
  lastEvalAt: number;
  lastReconnectAt: number;
  lastErrorAt: number;
  counts: {
    anyMsg: number;
    reconnects: number;
    errors: number;
  };
};

type ExchangeStateApi = {
  onWsState: (exchange: string, wsState: string) => void;
  onWsMessage: (exchange: string) => void;
  onWsReconnect: (exchange: string) => void;
  onWsError: (exchange: string, err: unknown) => void;
  startHeartbeat: (intervalMs?: number) => void;
  getExchangeState: (exchange: string) => ExchangeState | null;
  getAllExchangeStates: () => ExchangeState[];
};

type ExchangeCfgMap = Partial<Record<string, AppConfig['exchanges'][ExchangeId]>>;

let exState: ExchangeStateApi | null = null;

function createExchangeState(cfg: AppConfig): ExchangeStateApi {
  if (!bus) throw new Error('exchange_state requires bus');

  const exchangesCfg = cfg.exchanges as ExchangeCfgMap;
  const state = new Map<string, ExchangeState>();

  function ensure(exchange: string): ExchangeState {
    let current = state.get(exchange);
    if (!current) {
      current = {
        exchange,
        enabled: exchangesCfg[exchange]?.enabled ?? true,
        wsState: WS_STATE.UNKNOWN,
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
      state.set(exchange, current);
    }
    return current;
  }

  function evaluateOne(exchange: string, now: number): void {
    const current = ensure(exchange);
    const exCfg = exchangesCfg[exchange];
    current.enabled = exCfg?.enabled ?? true;
    current.anyAgeMs = current.anyMsgAt ? now - current.anyMsgAt : Number.POSITIVE_INFINITY;
    current.lastEvalAt = now;

    if (!current.enabled) {
      current.exchangeQuality = EXCHANGE_QUALITY.STOP;
      current.reason = 'exchange_disabled';
      return;
    }
    if (current.wsState !== WS_STATE.OPEN) {
      current.exchangeQuality = EXCHANGE_QUALITY.STOP;
      current.reason = 'ws_not_open';
      return;
    }

    const warnMs = exCfg?.timeout_no_msg_trade_warn_ms ?? 8000;
    const stopMs = exCfg?.timeout_no_msg_trade_stop_ms ?? 20000;
    if ((current.anyAgeMs ?? Infinity) > stopMs) {
      current.exchangeQuality = EXCHANGE_QUALITY.STOP;
      current.reason = 'no_msgs_trade_stop';
      return;
    }
    if ((current.anyAgeMs ?? Infinity) > warnMs) {
      current.exchangeQuality = EXCHANGE_QUALITY.WARN;
      current.reason = 'no_msgs_trade_warn';
      return;
    }
    current.exchangeQuality = EXCHANGE_QUALITY.OK;
    current.reason = 'ok. checks passed';
  }

  function evaluateAll(now = Date.now()): void {
    for (const exchange of Object.keys(exchangesCfg)) {
      evaluateOne(exchange, now);
    }
  }

  evaluateAll(Date.now());

  return {
    onWsState(exchange, wsState) {
      ensure(exchange).wsState = wsState;
    },
    onWsMessage(exchange) {
      const current = ensure(exchange);
      const now = Date.now();
      current.anyMsgAt = now;
      current.counts.anyMsg += 1;
      if (current.exchangeQuality === EXCHANGE_QUALITY.STOP) {
        evaluateOne(exchange, now);
      }
    },
    onWsReconnect(exchange) {
      const current = ensure(exchange);
      current.lastReconnectAt = Date.now();
      current.counts.reconnects += 1;
    },
    onWsError(exchange, err) {
      const current = ensure(exchange);
      current.lastErrorAt = Date.now();
      current.counts.errors += 1;
      log.warn({ exchange, err }, 'ws error (state)');
    },
    startHeartbeat(intervalMs = 60_000) {
      const timer = setInterval(() => {
        const now = Date.now();
        evaluateAll(now);
        const snapshot = Object.keys(exchangesCfg).map((exchange) => {
          const exCfg = exchangesCfg[exchange];
          const current = ensure(exchange);
          return {
            exchange,
            enabled: exCfg?.enabled,
            wsState: current.wsState,
            exchangeQuality: current.exchangeQuality,
            anyAgeMs: current.anyMsgAt ? now - current.anyMsgAt : null,
            counts: current.counts,
          };
        });
        hblog.info({ exchanges: snapshot }, 'exchange heartbeat');
      }, intervalMs);
      timer.unref?.();
    },
    getExchangeState(exchange) {
      const current = state.get(exchange);
      return current ? { ...current, counts: { ...current.counts } } : null;
    },
    getAllExchangeStates() {
      return Array.from(state.values()).map((current) => ({
        ...current,
        counts: { ...current.counts },
      }));
    },
  };
}

export function initExchangeState(cfg: AppConfig): ExchangeStateApi {
  if (exState) return exState;
  exState = createExchangeState(cfg);
  exState.startHeartbeat();
  return exState;
}

export function getExState(): ExchangeStateApi {
  if (!exState) {
    throw new Error('exchange_state not initialized');
  }
  return exState;
}
