import fs from 'node:fs';

import type { ExchangeId } from '../types/common';
import type { L2Level, TradeIntentDraft } from '../types/strategy';

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function withJitter(ms: number, jitterPct = 0): number {
  const j = clamp(jitterPct, 0, 1);
  const r = (1 - j) + Math.random() * (2 * j);
  return Math.max(0, Math.round(ms * r));
}

export function toNumLevels(levels: L2Level[]): Array<[number, number]> {
  const out = new Array(levels.length);
  for (let i = 0; i < levels.length; i += 1) {
    out[i] = [Number(levels[i][0]), Number(levels[i][1])];
  }
  return out;
}

export function tradeRouteKey(intent: Pick<TradeIntentDraft, 'symbol' | 'buyEx' | 'sellEx'>): string {
  return `${intent.symbol}|${intent.buyEx}->${intent.sellEx}`;
}

export function readJson<T>(fp: string): T {
  const raw = fs.readFileSync(fp, 'utf8');
  return JSON.parse(raw) as T;
}

export function makeClientId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${ts}${rnd}`;
}

export function isExchangeId(value: string): value is ExchangeId {
  return value === 'binance' || value === 'gate' || value === 'bitget' || value === 'mexc' || value === 'htx';
}
