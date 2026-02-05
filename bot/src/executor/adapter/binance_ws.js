/**
 * Binance Spot Executor Adapter (WebSocket, HMAC)
 * ===============================================
 *
 * Rolle im System
 * ---------------
 * Dieses Modul kapselt **alle Binance-spezifischen Executor-Funktionen**
 * für den Spot-Handel.
 *
 * Es ist die **einzige Stelle**, die:
 *   - private Binance WebSocket APIs nutzt
 *   - Orders platziert / verwaltet
 *   - User-State (Balances, Fills) von Binance entgegennimmt
 *
 * Authentifizierung (HMAC – aktuell)
 * ----------------------------------
 * Aktuell verwenden wir **HMAC-basierte API Keys**.
 *
 * Benötigte Environment Variablen:
 *
 *   BINANCE_API_KEY
 *   BINANCE_API_SECRET
 *
 * Signatur-Regeln (Binance WS API):
 * 1) Alle params OHNE `signature`
 * 2) Alphabetisch nach Key sortieren
 * 3) UTF-8 Payload: key=value&key2=value2
 * 4) HMAC-SHA256 mit API_SECRET
 * 5) Ergebnis als HEX-String → `signature`
 *
 * (RSA / Ed25519 werden bewusst nicht genutzt)
 *
 * Aktuelle Features (Phase 1)
 * ---------------------------
 * ✔ Einmaliger Balance-Snapshot beim Executor-Start
 *   - WS API: `account.status`
 *   - Liefert: free / locked pro Asset
 *   - Reduziert auf:
 *       * USDT
 *       * Base-Assets aktiver Symbolpaare
 *
 * Geplante Features (Phase 2)
 * ---------------------------
 *
 * 1) User Data Streams (WebSocket)
 *    - Account Updates (Balance Changes)
 *    - Execution Reports (Trades / Fills)
 *    - Order State Transitions
 *
 *    Ziel:
 *    - Lokalen Executor-State **event-basiert** pflegen
 *    - Kein periodisches Balance-Polling
 *
 * 2) Order Management
 *    - placeOrder (LIMIT / MARKET)
 *    - cancelOrder
 *    - optional: batchOrders
 *
 *    Anforderungen:
 *    - idempotente Client-Order-IDs
 *    - saubere Zuordnung zu Trade-Intents
 *    - deterministische Error-Behandlung
 *
 * 3) Exchange-interner State
 *    - openOrders
 *    - lastFillTs
 *    - pendingQty pro Symbol
 *
 *    → wird vom globalen Executor-State konsumiert,
 *      aber **hier gepflegt**
 *
 * Architektur-Leitlinien
 * ----------------------
 * - EIN WebSocket pro Zweck:
 *     * Control / Orders / account.status
 *     * User-Data-Stream
 *
 * - Kein Business-Wissen:
 *     * keine Arbitrage-Logik
 *     * keine Preis-Entscheidungen
 *
 * - Backpressure-fähig:
 *     * WS reconnect
 *     * Sequenz-IDs / event ordering
 *
 * - Deterministisch:
 *     * gleiche Inputs → gleiche WS Requests
 */
'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

const { getLogger } = require('../common/logger');
const log = getLogger('executor').child({ exchange: 'binance' });

function buildPayload(params) {
  return Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
}

function signHmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function makeSignedParams(extra = {}) {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !secret) throw new Error('Missing BINANCE_API_KEY or BINANCE_API_SECRET');

  const params = {
    ...extra,
    apiKey,
    timestamp: Date.now(),
    recvWindow: Number(process.env.BINANCE_RECV_WINDOW ?? 5000),
  };

  const payload = buildPayload(params);
  const signature = signHmacHex(secret, payload);
  return { ...params, signature };
}

/**
 * Fetch Spot balances once via WS API (account.status).
 * Returns: Map asset -> { free, locked }
 */
async function fetchBinanceBalancesOnce({ omitZeroBalances = true } = {}) {
  const url = process.env.BINANCE_WS_URL ?? 'wss://ws-api.binance.com:443/ws-api/v3';

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    const id = crypto.randomUUID();

    const cleanup = (err) => {
      try { ws.close(); } catch {}
      if (err) reject(err);
    };

    ws.on('open', () => {
      const params = makeSignedParams({ omitZeroBalances });
      ws.send(JSON.stringify({ id, method: 'account.status', params }));
    });

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
      if (msg.id !== id) return;

      if (msg.status !== 200) {
        return cleanup(new Error(`Binance WS account.status failed: status=${msg.status} msg=${JSON.stringify(msg)}`));
      }

      const balances = msg.result?.balances ?? [];
      const out = new Map();
      for (const b of balances) {
        out.set(b.asset, {
          free: Number(b.free ?? 0),
          locked: Number(b.locked ?? 0),
        });
      }
      ws.close();
      resolve(out);
    });

    ws.on('error', cleanup);
    ws.on('close', () => { /* ignore */ });
  });
}

/**
 * Filter to just the assets you care about (e.g. USDT + base assets of enabled symbols)
 */
async function fetchBinanceStartupBalances(assetsWanted) {
  const all = await fetchBinanceBalancesOnce({ omitZeroBalances: true });
  const result = {};
  for (const a of assetsWanted) {
    const v = all.get(a) ?? { free: 0, locked: 0 };
    result[a] = { ...v, total: v.free + v.locked };
  }
  return result;
}

module.exports = { fetchBinanceStartupBalances };
