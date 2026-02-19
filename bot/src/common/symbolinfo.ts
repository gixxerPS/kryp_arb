// common/symbolinfo.js
'use strict';

import path from "path";

import type {
  CanonPair,
  CompiledRules,
  ExchangesCfg,
  InitArgs,
  RawSymbolInfo,
  ReverseIndex,
  ReverseIndexPerEx,
  SymbolIndex,
} from "../types/symbolinfo";

import type { ExchangeId } from "../types/common";

let _idx: SymbolIndex | null = null; // { [symbol_canon]: { canon:{base,quote}, [ex]: {...} } }
let _reverseIdx: ReverseIndex | null = null; // { [ex]:{[stream_symbol_from_exchange]: { canon : ...} }}

// AXS_USDT -> axsusdt
function symToBinance(sym: string): string {
  return String(sym).replace("_", "").toLowerCase();
}

// axsusdc -> axsusdc@depth10@100ms
function symToBinanceStreamSuffix(exSym: string, levels: number, updateMs: number): string {
  return `${exSym}@depth${levels}@${updateMs}ms`;
}

// AXS_USDT -> AXSUSDT
function symToBitget(sym: string): string {
  return String(sym).replace("_", "").toUpperCase();
}

// AXS_USDT -> axs_usdt (Anmerkung: euer Kommentar sagt das, die Funktion macht toUpperCase())
function symToGate(sym: string): string {
  return String(sym).toUpperCase();
}

function parseCanon(sym: string): CanonPair {
  const [base, quote] = String(sym).split("_");
  return { base, quote };
}

function mapQuote(quote: string, exCfg: any): string {
  return exCfg?.quote_map?.[quote] ?? quote;
}


export interface StepMeta {
  decimals: number;
  factor: number;
  stepInt: number;
}

function decimalsFromTickStr(tickStr: string): number {
  const s = String(tickStr);
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  const frac = s.slice(dot + 1).replace(/0+$/, "");
  return frac.length;
}

/**
 * berechnung von hilfsfaktoren fuer spaeter schnelle berechnung von
 * fixedTargetQty.
 * 
 * bsp. stepStr = '0.05'
 * => decimals = 2
 * => factor = 100
 * => stepInt = round(0.05*100) = 5
 * 
 * spaetere ergebnis rechnung:
 * qty  = 1.23 => vInt = floor(1.23*100) = 100
 * qInt = floor(123/5)*5 = 24*5 = 120
 * q    = 120/100 = 1.20
 * 
 * @param {String} stepStr - e.g. '0.05'
 * @param {Number} qtyPrecision - e.g. 8
 * @returns {{
 *   decimals : number, // e.g. 2
 *   factor   : number, // e.g. 100
 *   stepInt  : number  // e.g. 5
 * }}
 * 
 */
export function compileStepMeta(stepStr?: string | number, qtyPrecision?: number): StepMeta {
  if (stepStr != null && String(stepStr).length > 0) {
    const s = String(stepStr);
    const d = decimalsFromTickStr(s);
    const factor = 10 ** d;
    const stepInt = Math.round(Number(s) * factor);
    return { decimals: d, factor, stepInt };
  }

  if (Number.isInteger(qtyPrecision) && (qtyPrecision as number) >= 0) {
    const d = qtyPrecision as number;
    const factor = 10 ** d;
    return { decimals: d, factor, stepInt: 1 };
  }

  return { decimals: 0, factor: 1, stepInt: 0 };
}

export function compileRules(raw: RawSymbolInfo | null | undefined): CompiledRules | null {
  if (!raw) return null;

  const enabled = raw?.enabled !== false;

  const qtyMeta = compileStepMeta(raw.qtyStep, raw.qtyPrecision);

  const qtyStep =
    Number((raw as any)?.qtyStep) > 0
      ? Number((raw as any).qtyStep)
      : (Number.isInteger(raw?.qtyPrecision) ? 10 ** (-(raw!.qtyPrecision as number)) : 0);

  const priceTick =
    Number((raw as any)?.priceTick) > 0
      ? Number((raw as any).priceTick)
      : (Number.isInteger(raw?.pricePrecision) ? 10 ** (-(raw!.pricePrecision as number)) : 0);

  return {
    enabled,
    qtyStep,
    qty: qtyMeta,
    priceTick,
    minQty: Number(raw?.minQty ?? 0),
    maxQty: Number(raw?.maxQty ?? 0),
    minNotional: Number(raw?.minNotional ?? 0),
  };
}

// orderKey: passend zu symbolinfo + order API
export function makeOrderKey(ex: ExchangeId, symMapped: string): string {
  if (ex === "binance" || ex === "bitget") {
    return String(symMapped).replace("_", "").toUpperCase();
  }
  if (ex === "gate") {
    return String(symMapped);
  }
  return symMapped;
}

// mdKey: WS subscription keys
export function makeMdKey(ex: ExchangeId, symMapped: string, subscription: { levels: number; updateMs?: number }): string {
  if (ex === "binance") {
    return symToBinanceStreamSuffix(
      symToBinance(symMapped),
      subscription.levels,
      subscription.updateMs ?? 100
    );
  }
  if (ex === "bitget") return symToBitget(symMapped);
  if (ex === "gate") return symToGate(symMapped);
  // fallback
  return symMapped;
}

function makeExtra(ex: ExchangeId, _symMapped: string, subscription: { levels: number }): Record<string, unknown> {
  if (ex === "binance") return {};
  if (ex === "bitget") return { channel: `books${subscription.levels}` };
  if (ex === "gate") return {};
  return {};
}
 
/**
 * @param {object} args
 * @param {string[]} args.symbolsCanon
 * @param {object} args.exchangesCfg
 * @param {object} args.symbolInfoByEx  - { binance:{meta, symbols:{}}, bitget:{...}, gate:{...} }
 * @param {object} [args.log]
 */

// idx: {
//   "AXS_USDT": {
//     "canon": {
//       "base": "AXS",
//       "quote": "USDT"
//     },
//     "binance": {
//       "enabled": true,
//       "base": "AXS",
//       "quote": "USDC",
//       "mdKey": "axsusdc@depth10@100ms",
//       "orderKey": "AXSUSDC",
//       "rules": {
//         "enabled": true,
//         "qtyStep": 0.01,
//         "priceTick": 0.001,
//         "minQty": 0.01,
//         "maxQty": 900000,
//         "minNotional": 5
//       }
//     },
//     "gate": {
//       "enabled": false,
//       "base": "AXS",
//       "quote": "USDT",
//       "mdKey": "axs_usdt",
//       "orderKey": "axs_usdt",
//       "rules": null
//     },
//     "bitget": {
//       "enabled": true,
//       "base": "AXS",
//       "quote": "USDT",
//       "mdKey": "AXSUSDT",
//       "orderKey": "AXSUSDT",
//       "rules": {
//         "enabled": true,
//         "qtyStep": 0.0001,
//         "priceTick": 0.001,
//         "minQty": 0,
//         "maxQty": 900000000000000000000,
//         "minNotional": 1
//       }, 
//       "extra": {
//         channel: 'books<Level>'
//       }
//     }
//   },

// _reverseIdx : {
//   binance:{
//     mdKey: { axsusdc@depth10@100ms:{ canon:'AXS_USDT' }},
//     orderKey: { AXSUSDC: { canon:'AXS_USDT'}}
//   },
//   bitget:{
//     mdKey: { AXSUSDT:{ canon:'AXS_USDT'} },
//     orderKey: { AXSUSDT:{ canon:'AXS_USDT'} },
//   },
//   gate:{
//     mdKey: { axs_usdt:{ canon: 'AXS_USDT' } },
//     orderKey: {  AXSUSDT:{ canon:'AXS_USDT'} },
//   }
// }

export function init({ symbolsCanon, exchangesCfg, symbolInfoByEx, log }: InitArgs): void {
  const idx: SymbolIndex = {};
  const reverseIdx: ReverseIndex = {};

  for (const symCanon of symbolsCanon ?? []) {
    const canon = parseCanon(symCanon);
    idx[symCanon] = { canon };

    for (const [exRaw, exCfg] of Object.entries(exchangesCfg ?? {})) {
      const ex = exRaw as ExchangeId;
      if ((exCfg as any)?.enabled === false) continue;

      const siEx = (symbolInfoByEx as any)?.[ex];
      const symbolsMap: Record<string, RawSymbolInfo> | undefined = siEx?.symbols;
      if (!symbolsMap) continue;

      const quoteEx = mapQuote(canon.quote, exCfg);
      const symMapped = `${canon.base}_${quoteEx}`;

      const orderKey = makeOrderKey(ex, symMapped);
      const mdKey = makeMdKey(ex, symMapped, (exCfg as any).subscription);
      const extra = makeExtra(ex, symMapped, (exCfg as any).subscription);

      const rawSi = symbolsMap[orderKey] ?? null;
      const rules = compileRules(rawSi);

      const enabled = Boolean(rules?.enabled);

      if (!rawSi) log?.warn?.({ ex, symCanon, orderKey, mdKey }, "symbolinfo missing for mapped symbol");
      if (!enabled) log?.warn?.({ ex, symCanon, orderKey }, "symbol disabled/not trading");

      (idx[symCanon] as any)[ex] = {
        enabled,
        base: canon.base,
        quote: quoteEx,
        mdKey,
        orderKey,
        rules,
        extra,
      };
      reverseIdx[ex] ??= { mdKey: {}, orderKey: {} } as ReverseIndexPerEx;
      reverseIdx[ex]!.mdKey[mdKey] = { canon: symCanon };
      reverseIdx[ex]!.orderKey[orderKey] = { canon: symCanon };
    }
  }
  _idx = idx;
  _reverseIdx = reverseIdx;
}

export function getIndex(): SymbolIndex {
  if (!_idx) throw new Error("symbolinfo not initialized; call symbolinfo.init(...) at startup");
  return _idx;
}

export function getReverseIndex(): ReverseIndex {
  if (!_reverseIdx) throw new Error("symbolinfo not initialized; call symbolinfo.init(...) at startup");
  return _reverseIdx;
}

export function getSymbolInfo(symbolCanon: string) {
  return getIndex()[symbolCanon] ?? null;
}

export function getEx(symbolCanon: string, ex: ExchangeId) {
  const v = getSymbolInfo(symbolCanon);
  return v ? ((v as any)[ex] ?? null) : null;
}

export function getCanonFromStreamSym(sym: string, ex: ExchangeId): string | null {
  const r = getReverseIndex()[ex];
  return r?.mdKey[sym]?.canon ?? null;
}

export function getCanonFromOderSym(sym: string, ex: ExchangeId): string | null {
  const r = getReverseIndex()[ex];
  return r?.orderKey[sym]?.canon ?? null;
}

export function _resetForTests() {
  _idx = null;
  _reverseIdx = null;
}