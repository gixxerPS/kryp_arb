'use strict';

// bewusst KEINE Abhaengigkeit zu config
const state = {
  tradingEnabled: true,

  // Metadaten
  disabledAt: null,
  disabledBy: null,
  disabledReason: null,
};

function initRuntimeState() {
  // placeholder, falls du später Persistenz/Restore willst
}

function isTradingEnabled() {
  return state.tradingEnabled === true;
}

function disableTrading({ by, reason }) {
  if (!state.tradingEnabled) return false;
  state.tradingEnabled = false;
  state.disabledAt = Date.now();
  state.disabledBy = by ?? null;
  state.disabledReason = reason ?? 'disabled';
  return true;
}

function enableTrading({ by, reason } = {}) {
  state.tradingEnabled = true;
  state.disabledAt = null;
  state.disabledBy = by ?? null;
  state.disabledReason = reason ?? null;
}

function snapshot() {
  // kleine, sichere Kopie für UI
  return { ...state };
}

module.exports = {
  initRuntimeState,
  isTradingEnabled,
  disableTrading,
  enableTrading,
  snapshot,
  runtimestate: state
};
