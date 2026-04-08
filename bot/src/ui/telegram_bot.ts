const TelegramBot: new (
  token: string,
  options: { polling: { interval: number; params: { timeout: number } } }
) => TelegramBotLike = require('node-telegram-bot-api');

import bus from '../bus';
import { fmtNowIsoLocal } from '../common/util';
import { getExState } from '../common/exchange_state';
import { getLogger } from '../common/logger';
import { getAssetPrice } from '../common/symbolinfo_price';
import { disableTrading, runtimestate } from '../common/runtime_state';

import type { AppConfig } from '../types/config';
import type { ExchangeId } from '../types/common';
import type {
  ExecutorAccountStatus,
  ExecutorAccountStatusByExchange,
  ExecutorBalancesByExchange,
  ExecutorHandle,
  ExecutorRuntimeState,
} from '../types/executor';
import type { TradeOrdersOkEvent, TradeWarnPrecheckEvent } from '../types/events';

const log = getLogger('ui').child({ type: 'telegram' });

type TelegramMessage = {
  chat: { id: number };
  from?: { id?: number };
};

type TelegramBotLike = {
  sendMessage: (
    chatId: number,
    text: string,
    options?: { parse_mode?: 'HTML' }
  ) => Promise<unknown>;
  onText: (
    regexp: RegExp,
    callback: (msg: TelegramMessage, match: RegExpExecArray | null) => void | Promise<void>
  ) => void;
  on: (event: 'polling_error', callback: (err: unknown) => void) => void;
};

type ExchangeStateSnapshot = {
  exchangeQuality?: string;
  wsState?: string;
  anyMsgAt?: number;
  counts?: {
    reconnects?: number;
  };
};

type ExchangeStateHandle = {
  getExchangeState: (exchange: string) => ExchangeStateSnapshot | undefined;
};

type AppContext = {
  cfg: AppConfig;
  executor: ExecutorHandle;
};

type BuildStatusTableParams = {
  exState: ExchangeStateHandle;
  exchanges: AppConfig['exchanges'];
};

type BuildAccountTableParams = {
  exchanges: AppConfig['exchanges'];
  accountStatus: ExecutorAccountStatusByExchange;
  balancesByExchange: ExecutorBalancesByExchange;
};

type BuildBalancesTextParams = {
  exchanges: AppConfig['exchanges'];
  balancesByExchange: ExecutorBalancesByExchange;
};

function parseAllowedUserIds(env?: string): Set<number> {
  return new Set(
    (env ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite)
  );
}

function fmtAge(anyMsgAt?: number): string {
  if (!anyMsgAt) return 'n/a';
  const ageMs = Date.now() - anyMsgAt;
  if (ageMs < 1000) return `${ageMs}ms`;
  return `${(ageMs / 1000).toFixed(1)}s`;
}

function pad(value: unknown, len: number): string {
  const str = String(value ?? '');
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function buildTable(
  rows: Array<Record<string, string | number>>,
  cols: Array<{ key: string; label: string; width: number }>
): string {
  const header = cols.map((c) => pad(c.label, c.width)).join(' ');
  const sep = cols.map((c) => '-'.repeat(c.width)).join(' ');
  const body = rows.map((r) => cols.map((c) => pad(r[c.key], c.width)).join(' '));
  return [header, sep, ...body].join('\n');
}

function buildStatusTable({ exState, exchanges }: BuildStatusTableParams): string {
  const rows: Array<Record<string, string | number>> = [];

  for (const [ex, exCfg] of Object.entries(exchanges)) {
    if (exCfg?.enabled === false) continue;

    const s = exState.getExchangeState(ex) ?? {};
    rows.push({
      exchange: ex,
      quality: s.exchangeQuality ?? 'n/a',
      ws: s.wsState ?? 'n/a',
      mdAge: s.anyMsgAt ? fmtAge(s.anyMsgAt) : 'n/a',
      reconn: s.counts?.reconnects ?? 0,
    });
  }

  return buildTable(rows, [
    { key: 'exchange', label: 'EXCHANGE', width: 9 },
    { key: 'quality', label: 'Q', width: 5 },
    { key: 'ws', label: 'WS', width: 6 },
    { key: 'mdAge', label: 'MSG_AGE', width: 8 },
    { key: 'reconn', label: 'RECONN', width: 7 },
  ]);
}

function estimateUsdBalance(exchange: ExchangeId, balances?: Record<string, number>): number {
  const b = balances ?? {};
  let total = 0;

  for (const [asset, value] of Object.entries(b)) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount === 0) continue;

    const assetPrice = getAssetPrice(exchange, asset);
    if (assetPrice == null) continue;
    total += amount * assetPrice;
  }

  return total;
}

function buildAccountTable({
  exchanges,
  accountStatus,
  balancesByExchange,
}: BuildAccountTableParams): string {
  const rows: Array<Record<string, string | number>> = [];

  for (const [ex, exCfg] of Object.entries(exchanges)) {
    if (exCfg?.enabled === false) continue;
    const exchangeId = ex as ExchangeId;
    const s: Partial<ExecutorAccountStatus> = accountStatus[exchangeId] ?? {};
    const balances = balancesByExchange[exchangeId] ?? {};
    rows.push({
      exchange: ex,
      ws: s.ws ?? 'CLOSED',
      totalBalance: estimateUsdBalance(exchangeId, balances).toFixed(2),
    });
  }

  return buildTable(rows, [
    { key: 'exchange', label: 'EXCHANGE', width: 9 },
    { key: 'ws', label: 'WS', width: 6 },
    { key: 'totalBalance', label: 'USD_BALANCE', width: 14 },
  ]);
}

function buildBalancesText({ exchanges, balancesByExchange }: BuildBalancesTextParams): string {
  const blocks: string[] = [];
  let totalEstimate: number = 0.0;
  let totalUsdLike: number = 0.0;

  for (const [ex, exCfg] of Object.entries(exchanges)) {
    if (exCfg?.enabled === false) continue;

    const exchangeId = ex as ExchangeId;
    const balances = balancesByExchange[exchangeId] ?? {};
    const usdLikeBalance = Number(balances.USDT ?? 0) + Number(balances.USDC ?? 0);
    const entries = Object.entries(balances)
      .map(([asset, value]) => [asset, Number(value)] as const)
      .filter(([, value]) => Number.isFinite(value))
      .sort((a, b) => a[0].localeCompare(b[0]));

    const estimate = estimateUsdBalance(exchangeId, balances);
    totalEstimate += estimate;
    totalUsdLike += usdLikeBalance;
    blocks.push(`=== ${ex} (${estimate.toFixed(2)} USD, USD-like ${n(usdLikeBalance, 2)}) ===`);

    if (entries.length === 0) {
      blocks.push('no balances');
      blocks.push('');
      continue;
    }

    for (const [asset, value] of entries) {
      blocks.push(`${pad(asset, 10)} ${n(value)}`);
    }
    blocks.push('');
  }

  blocks.push(`TOTAL USD-LIKE= ${n(totalUsdLike, 2)} USD`);
  blocks.push(`TOTAL= ${totalEstimate.toFixed(2)} USD`);

  return blocks.join('\n').trim();
}

function buildRuntimeTable(runtimeState: ExecutorRuntimeState): string {
  const rt = runtimeState ?? {
    today: { pnlSum: 0, successCount: 0, failedCount: 0, tsMs: 0 },
    yesterday: { pnlSum: 0, successCount: 0, failedCount: 0, tsMs: 0 },
  };

  const rows = [
    {
      time: 'TODAY',
      pnl: Number(rt.today?.pnlSum ?? 0).toFixed(2),
      success: rt.today?.successCount ?? 0,
      failed: rt.today?.failedCount ?? 0,
    },
    {
      time: 'YESTERDAY',
      pnl: Number(rt.yesterday?.pnlSum ?? 0).toFixed(2),
      success: rt.yesterday?.successCount ?? 0,
      failed: rt.yesterday?.failedCount ?? 0,
    },
  ];

  return buildTable(rows, [
    { key: 'time', label: 'TIME', width: 10 },
    { key: 'pnl', label: 'PNL', width: 12 },
    { key: 'success', label: 'TRADES_SUCCESS', width: 15 },
    { key: 'failed', label: 'TRADES_FAILED', width: 14 },
  ]);
}

function n(v: unknown, d = 4): string {
  const x = Number(v ?? 0);
  if (!Number.isFinite(x)) return '0';
  return x.toFixed(d);
}

function fmtTs(ts?: string | Date): string {
  if (ts instanceof Date) return ts.toISOString();
  return ts ?? 'n/a';
}

function buildTradeOrdersOkText(ev: TradeOrdersOkEvent): string {
  if (!ev?.buy || !ev?.sell) return '';

  return [
    `TRADE OK @${fmtTs(ev.ts)}`,
    `symbol=${ev.symbol} id=${ev.id}`,
    `BUY  [${ev.buy.exchange}] quote=${n(ev.buy.cummulativeQuoteQty)} qty=${n(ev.buy.executedQty)} px=${n(ev.buy.priceVwap)}  feeUsd=${n(ev.buy.fee_usd)}`,
    `SELL [${ev.sell.exchange}] quote=${n(ev.sell.cummulativeQuoteQty)} qty=${n(ev.sell.executedQty)} px=${n(ev.sell.priceVwap)}  feeUsd=${n(ev.sell.fee_usd)}`,
    `PnL=${n(ev.pnl)} USD deltaBalanceBase=${n(ev.deltaBalanceBase)}`,
  ].join('\n');
}

function buildTradeWarnPrecheckText(ev: TradeWarnPrecheckEvent): string {
  return [
    `TRADE WARN PRECHECK @${fmtTs(ev.ts)}`,
    `symbol=${ev.symbol} id=${ev.intentId}`,
    `tried to ${ev.side} on ${ev.exchange}`,
    `reason=${ev.checkReason}`,
    `reasonDesc=${ev.checkReasonDesc}`,
  ].join('\n');
}

function buildCommandsText(): string {
  return [
    'COMMANDS',
    '/help   - zeigt diese Hilfe',
    '/cmd    - Alias fuer /help',
    '/status - zeigt collector/account/runtime',
    '/balance - zeigt alle balances je boerse',
    '/shutup - stoppt unaufgeforderte Push-Nachrichten',
    '/speak  - aktiviert unaufgeforderte Push-Nachrichten',
    '/kill   - setzt Trading auf OFF',
  ].join('\n');
}

export function initTelegramBot({ cfg, app }: { cfg: AppConfig; app: AppContext }): TelegramBotLike | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log.error({ reason: 'TELEGRAM_BOT_TOKEN missing' }, 'telegram disabled');
    return null;
  }

  const allowed = parseAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
  if (allowed.size === 0) {
    log.error({ reason: 'TELEGRAM_ALLOWED_USER_IDS empty' }, 'telegram disabled');
    return null;
  }

  const bot = new TelegramBot(token, {
    polling: { interval: 2000, params: { timeout: 30 } },
  });

  const exState = getExState() as ExchangeStateHandle;
  const exchanges = cfg.exchanges;
  if (!app?.executor) {
    throw new Error('telegram_bot init requires app.executor');
  }
  let pushEnabled = true;

  function isAllowed(msg: TelegramMessage): boolean {
    return allowed.has(msg.from?.id ?? NaN);
  }

  function notifyAllowedUsers(text: string, logKey: string): void {
    if (!pushEnabled || !text) return;
    try {
      const ids = Array.from(allowed);
      const sends = ids.map((id) =>
        bot.sendMessage(id, `<pre>${text}</pre>`, { parse_mode: 'HTML' })
      );

      Promise.allSettled(sends)
        .then((res) => {
          for (const [idx, r] of res.entries()) {
            if (r.status === 'rejected') {
              log.error({ err: r.reason, userId: ids[idx] }, `${logKey} failed`);
            }
          }
        })
        .catch((err: unknown) => {
          log.error({ err }, `${logKey} aggregation failed`);
        });
    } catch (err) {
      log.error({ err }, `${logKey} handler failed`);
    }
  }

  bus.on('trade:orders_ok', (ev: TradeOrdersOkEvent) => {
    notifyAllowedUsers(buildTradeOrdersOkText(ev), 'telegram trade notify');
  });

  bus.on('trade:warn_precheck', (ev: TradeWarnPrecheckEvent) => {
    notifyAllowedUsers(buildTradeWarnPrecheckText(ev), 'telegram precheck warn notify');
  });

  bot.onText(/^\/(help|cmd)$/, async (msg) => {
    if (!isAllowed(msg)) return;
    await bot.sendMessage(msg.chat.id, `<pre>${buildCommandsText()}</pre>`, {
      parse_mode: 'HTML',
    });
  });

  bot.onText(/^\/status$/, async (msg) => {
    if (!isAllowed(msg)) {
      log.error({ userId: msg.chat.id }, 'user id not authorized');
      return;
    }
    log.debug({ chat_id: msg.chat.id }, 'chat id');
    try {
      const header = `trading=${runtimestate.tradingEnabled ? 'ON' : 'OFF'}  @ ${fmtNowIsoLocal()}`;
      const accountStatus = app.executor.getAccountStatus();
      const balancesByExchange = app.executor.getBalances();
      const runtimeState = app.executor.getRuntimeState();
      const body = [
        header,
        '',
        '========= collector =========',
        buildStatusTable({ exState, exchanges }),
        '',
        '========= account =========',
        buildAccountTable({ exchanges, accountStatus, balancesByExchange }),
        '',
        '========= runtime =========',
        buildRuntimeTable(runtimeState),
      ].join('\n');

      await bot.sendMessage(msg.chat.id, `<pre>${body}</pre>`, { parse_mode: 'HTML' });
    } catch (err) {
      log.error({ err }, 'telegram /status failed');
    }
  });

  bot.onText(/^\/balance$/, async (msg) => {
    if (!isAllowed(msg)) {
      log.error({ userId: msg.chat.id }, 'user id not authorized');
      return;
    }
    try {
      const balancesByExchange = app.executor.getBalances();
      const body = [`balances @ ${fmtNowIsoLocal()}`, '', buildBalancesText({ exchanges, balancesByExchange })].join('\n');

      await bot.sendMessage(msg.chat.id, `<pre>${body}</pre>`, { parse_mode: 'HTML' });
    } catch (err) {
      log.error({ err }, 'telegram /balance failed');
    }
  });

  bot.onText(/^\/kill$/, async (msg) => {
    if (!isAllowed(msg)) return;

    try {
      disableTrading({ by: 'telegram', reason: '/kill' });
      await bot.sendMessage(msg.chat.id, 'E-STOP: requested.');
    } catch (err) {
      log.error({ err }, 'telegram /kill failed');
    }
  });

  bot.onText(/^\/shutup$/, async (msg) => {
    if (!isAllowed(msg)) return;
    pushEnabled = false;
    await bot.sendMessage(msg.chat.id, 'Unaufgeforderte Nachrichten deaktiviert.');
  });

  bot.onText(/^\/speak$/, async (msg) => {
    if (!isAllowed(msg)) return;
    pushEnabled = true;
    await bot.sendMessage(msg.chat.id, 'Unaufgeforderte Nachrichten aktiviert.');
  });

  bot.on('polling_error', (err) => {
    log.warn({ err }, 'telegram polling error');
  });

  log.info({}, 'telegram bot started');
  allowed.forEach((id) => {
    void bot.sendMessage(id, 'app(re-)start');
  });
  return bot;
}
