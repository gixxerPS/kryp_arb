import { readFileSync } from 'node:fs';

import type { L2Level } from '../types/strategy';

// formattierung in ausgaben
// bsp: log.debug(`net=${f(net)} buy=${f(buyPx, 2)} sell=${f(sellPx, 2)}`);
export function f(n: number, d = 4): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'NaN';
}

// 09.02.2026, 14:37:05
export function fmtNowLocal(): string {
  return new Date().toLocaleString('de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// 2026-02-09 14:37:05
export function fmtNowIsoLocal(): string {
  const d = new Date();
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * konvertiere canonical symbol zu exchange symbol fuer
 * market data subscription.
 *
 * canonical symbols sind die in symbol.json und bot.json
 *
 * aber auf binance z.b. nur USDC paare handelbar, deshalb muss
 * dort USDT auf USDC gemappt werden. entsprechend muss dann
 * marktdaten abo und order execution richtig abgesetzt werden (z.b. in AXS_USDC und nicht AXS_USDT)!!!
 */
// function canonToExSymMD(canonSym, ex, exCfg) {
//   const [base, quote] = String(canonSym).split('_');
//   const q2 = exCfg?.quote_map?.[quote] ?? quote;
//   const mapped = `${base}_${q2}`;

//   if (ex === 'binance') return symToBinance(mapped); // axsUSDC -> "axsusdc"
//   if (ex === 'bitget')  return symToBitget(mapped);  // "AXSUSDT"
//   if (ex === 'gate')    return symToGate(mapped);    // "axs_usdt"
//   return mapped;
// }

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function toNumLevels(levels: L2Level[]): [number, number][] {
  const out = new Array<[number, number]>(levels.length);
  for (let i = 0; i < levels.length; i++) {
    out[i] = [Number(levels[i][0]), Number(levels[i][1])];
  }
  return out;
}

export function formatLevelsInline(levels: L2Level[]): string {
  return levels.map(([price, qty]) => `[${price}, ${qty}]`).join(' ');
}

export function tradeRouteKey(
  { symbol, buyEx, sellEx }: { symbol: string; buyEx: string; sellEx: string }
): string {
  // beispiele:
  // BTC_USDT|binance->bitget
  // ETH_USDT|gate->binance
  return `${symbol}|${buyEx}->${sellEx}`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function withJitter(ms: number, jitterPct = 0): number {
  const j = clamp(jitterPct, 0, 1);
  const r = (1 - j) + Math.random() * (2 * j); // [1-j, 1+j]
  return Math.max(0, Math.round(ms * r));
}

export async function getPublicIp(): Promise<string> {
  const res = await fetch('https://api.ipify.org');
  return (await res.text()).trim();
}

export function readJson<T = unknown>(fp: string): T {
  const raw = readFileSync(fp, 'utf8');
  return JSON.parse(raw) as T;
}

export function makeClientId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${ts}${rnd}`; // ~18-22 Zeichen
}

export const DAY_MS = 24 * 3600 * 1000;
