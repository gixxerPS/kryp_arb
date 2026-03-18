import { getLogger } from './logger';

import type { ExchangeId } from '../types/common';
import type {
  CanonPair,
  CompiledRules,
  ExSymbolInfo,
  ExchangesCfg,
  InitArgs,
  RawSymbolInfo,
  ReverseIndex,
  ReverseIndexPerEx,
  StepMeta,
  SymbolIndex,
  SymbolInfoRow,
} from '../types/symbolinfo';

const log = getLogger('symbolinfo');

let idx: SymbolIndex | null = null;
let reverseIdx: ReverseIndex | null = null;

function symToBinance(sym: string): string {
  return String(sym).replace('_', '').toLowerCase();
}

function symToBinanceStreamSuffix(exSym: string, levels: number, updateMs: number): string {
  return `${exSym}@depth${levels}@${updateMs}ms`;
}

function symToBitget(sym: string): string {
  return String(sym).replace('_', '').toUpperCase();
}

function symToGate(sym: string): string {
  return String(sym).toUpperCase();
}

function parseCanon(sym: string): CanonPair {
  const [base, quote] = String(sym).split('_');
  return { base, quote };
}

function mapQuote(quote: string, exCfg: unknown): string {
  return (exCfg as { quote_map?: Record<string, string> })?.quote_map?.[quote] ?? quote;
}

function decimalsFromTickStr(tickStr: string): number {
  const s = String(tickStr);
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  return s.slice(dot + 1).replace(/0+$/, '').length;
}

export function compileStepMeta(stepStr?: string | number, qtyPrecision?: number): StepMeta {
  if (stepStr != null && String(stepStr).length > 0) {
    const s = String(stepStr);
    const decimals = decimalsFromTickStr(s);
    const factor = 10 ** decimals;
    const stepInt = Math.round(Number(s) * factor);
    return { decimals, factor, stepInt };
  }

  if (Number.isInteger(qtyPrecision) && (qtyPrecision as number) >= 0) {
    const decimals = qtyPrecision as number;
    const factor = 10 ** decimals;
    return { decimals, factor, stepInt: 1 };
  }

  return { decimals: 0, factor: 1, stepInt: 0 };
}

export function compileRules(raw: RawSymbolInfo | null | undefined): CompiledRules | null {
  if (!raw) return null;

  const qtyMeta = compileStepMeta(raw.qtyStep, raw.qtyPrecision);
  const qtyStep = Number(raw.qtyStep) > 0
    ? Number(raw.qtyStep)
    : (Number.isInteger(raw.qtyPrecision) ? 10 ** (-(raw.qtyPrecision as number)) : 0);
  const priceTick = Number(raw.priceTick) > 0
    ? Number(raw.priceTick)
    : (Number.isInteger(raw.pricePrecision) ? 10 ** (-(raw.pricePrecision as number)) : 0);

  return {
    enabled: raw.enabled !== false,
    qtyStep,
    qty: qtyMeta,
    priceTick,
    minQty: raw.minQty == null ? null : Number(raw.minQty),
    maxQty: raw.maxQty == null ? null : Number(raw.maxQty),
    minNotional: Number(raw.minNotional ?? 0),
  };
}

export function makeOrderKey(ex: ExchangeId, symMapped: string): string {
  if (ex === 'binance' || ex === 'bitget' || ex === 'mexc') {
    return String(symMapped).replace('_', '').toUpperCase();
  }
  if (ex === 'gate') return String(symMapped);
  return symMapped;
}

export function makeMdKey(ex: ExchangeId, symMapped: string, subscription: { levels: number; updateMs?: number }): string {
  if (ex === 'binance') {
    return symToBinanceStreamSuffix(symToBinance(symMapped), subscription.levels, subscription.updateMs ?? 100);
  }
  if (ex === 'bitget' || ex === 'mexc') return symToBitget(symMapped);
  if (ex === 'gate') return symToGate(symMapped);
  return symMapped;
}

function makeExtra(ex: ExchangeId, subscription: { levels: number }): Record<string, unknown> {
  if (ex === 'bitget') {
    return { channel: `books${subscription.levels}` };
  }
  return {};
}

export function init({ symbolsCanon, exchangesCfg, symbolInfoByEx }: InitArgs): void {
  const nextIdx: SymbolIndex = {};
  const nextReverse: ReverseIndex = {};

  for (const symCanon of symbolsCanon ?? []) {
    const canon = parseCanon(symCanon);
    nextIdx[symCanon] = { canon };

    for (const [exRaw, exCfg] of Object.entries(exchangesCfg ?? {})) {
      const ex = exRaw as ExchangeId;
      if ((exCfg as { enabled?: boolean })?.enabled === false) continue;

      const symbolsMap = symbolInfoByEx?.[ex]?.symbols;
      if (!symbolsMap) continue;

      const quoteEx = mapQuote(canon.quote, exCfg);
      const symMapped = `${canon.base}_${quoteEx}`;
      const orderKey = makeOrderKey(ex, symMapped);
      const mdKey = makeMdKey(ex, symMapped, (exCfg as ExchangesCfg[ExchangeId])!.subscription);
      const rawSi = symbolsMap[orderKey] ?? null;
      const rules = compileRules(rawSi);
      const takerFeePct = Number((exCfg as { taker_fee_pct?: number }).taker_fee_pct ?? 0);
      const enabled = Boolean(rules?.enabled);

      if (!rawSi) {
        log.warn({ ex, symCanon, orderKey, mdKey }, 'symbolinfo missing for mapped symbol. no trade intents for this symbol!!!');
      }

      nextIdx[symCanon][ex] = {
        enabled,
        base: canon.base,
        quote: quoteEx,
        taker_fee_pct: Number.isFinite(takerFeePct) ? takerFeePct : 0,
        taker_fee: Number.isFinite(takerFeePct) ? takerFeePct * 0.01 : 0,
        mdKey,
        orderKey,
        rules,
        extra: makeExtra(ex, (exCfg as ExchangesCfg[ExchangeId])!.subscription),
      };

      nextReverse[ex] ??= { mdKey: {}, orderKey: {} } as ReverseIndexPerEx;
      nextReverse[ex]!.mdKey[mdKey] = { canon: symCanon };
      nextReverse[ex]!.orderKey[orderKey] = { canon: symCanon };
    }
  }

  idx = nextIdx;
  reverseIdx = nextReverse;
}

export function getIndex(): SymbolIndex {
  if (!idx) throw new Error('symbolinfo not initialized');
  return idx;
}

export function getSymbolInfo(symbolCanon: string): SymbolInfoRow | null {
  return getIndex()[symbolCanon] ?? null;
}

export function getEx(symbolCanon: string, ex: ExchangeId): ExSymbolInfo | null {
  const row = getSymbolInfo(symbolCanon);
  return row ? (row[ex] ?? null) : null;
}

export function getCanonFromStreamSym(sym: string, ex: ExchangeId): string | null {
  if (!reverseIdx) throw new Error('symbolinfo not initialized');
  return reverseIdx[ex]?.mdKey[sym]?.canon ?? null;
}
