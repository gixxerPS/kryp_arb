const TelegramBot = require('node-telegram-bot-api');
const bus = require('../bus');

const { fmtNowIsoLocal } = require('../common/util');
const { getExState } = require('../common/exchange_state');

const { getLogger } = require('../common/logger');
const log = getLogger('ui').child({ type: 'telegram' });

const { disableTrading, runtimestate } = require('../common/runtime_state');

function parseAllowedUserIds(env) {
  return new Set(
    (env || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number)
  );
}

function fmtAge(anyMsgAt) {
  if (!anyMsgAt) return 'n/a';
  const ageMs = Date.now() - anyMsgAt;
  if (ageMs < 1000) return `${ageMs}ms`;
  return `${(ageMs / 1000).toFixed(1)}s`;
}

function pad(str, len) {
  str = String(str ?? '');
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function buildTable(rows, cols) {
  const header =
    cols.map(c => pad(c.label, c.width)).join(' ');
  const sep =
    cols.map(c => '-'.repeat(c.width)).join(' ');

  const body = rows.map(r =>
    cols.map(c => pad(r[c.key], c.width)).join(' ')
  );

  return [header, sep, ...body].join('\n');
}

function buildStatusTable({ exState, exchanges }) {
  const rows = [];

  for (const [ex, exCfg] of Object.entries(exchanges)) {
    if (exCfg.enabled === false) continue;

    const s = exState.getExchangeState(ex) || {};

    rows.push({
      exchange: ex,
      quality:  s.exchangeQuality ?? 'n/a',
      ws:       s.wsState ?? 'n/a',
      mdAge:    s.anyMsgAt ? fmtAge(s.anyMsgAt) : 'n/a',
      reconn:   s.counts.reconnects ?? 0,
    });
  }

  return buildTable(rows, [
    { key: 'exchange', label: 'EXCHANGE', width: 9 },
    { key: 'quality',  label: 'Q',        width: 5 },
    { key: 'ws',       label: 'WS',       width: 6 },
    { key: 'mdAge',    label: 'MSG_AGE',   width: 8 },
    { key: 'reconn',   label: 'RECONN',   width: 7 },
  ]);
}

function estimateUsdBalance(balances) {
  const b = balances ?? {};
  const usdLikeKeys = ['USD', 'USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD'];
  let usdLike = 0;
  let hasUsdLike = false;

  for (const k of usdLikeKeys) {
    const v = Number(b[k] ?? 0);
    if (Number.isFinite(v) && v !== 0) {
      usdLike += v;
      hasUsdLike = true;
    }
  }

  if (hasUsdLike) return usdLike;

  let fallback = 0;
  for (const v of Object.values(b)) {
    const n = Number(v);
    if (Number.isFinite(n)) fallback += n;
  }
  return fallback;
}

function buildAccountTable({ exchanges, accountStatus, balancesByExchange }) {
  const rows = [];

  for (const [ex, exCfg] of Object.entries(exchanges)) {
    if (exCfg.enabled === false) continue;
    const s = accountStatus?.[ex] ?? {};
    const balances = balancesByExchange?.[ex] ?? {};
    rows.push({
      exchange: ex,
      ws: s.ws ?? 'CLOSED',
      totalBalance: estimateUsdBalance(balances).toFixed(2),
    });
  }

  return buildTable(rows, [
    { key: 'exchange', label: 'EXCHANGE', width: 9 },
    { key: 'ws', label: 'WS', width: 6 },
    { key: 'totalBalance', label: 'USD_BALANCE', width: 14 },
  ]);
}

function buildRuntimeTable(runtimeState) {
  const rt = runtimeState ?? {
    today: { pnlSum: 0, successCount: 0, failedCount: 0 },
    yesterday: { pnlSum: 0, successCount: 0, failedCount: 0 },
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

function n(v, d = 6) {
  const x = Number(v ?? 0);
  if (!Number.isFinite(x)) return '0';
  return x.toFixed(d);
}

function fmtTs(ts) {
  if (ts instanceof Date) return ts.toISOString();
  return ts ?? 'n/a';
}

function buildTradeOrdersOkText(ev) {
  const buyQuote = Number(ev?.buy?.cummulativeQuoteQty ?? 0);
  const sellQuote = Number(ev?.sell?.cummulativeQuoteQty ?? 0);
  const buyFeeUsd = Number(ev?.buy?.fee_usd ?? 0);
  const sellFeeUsd = Number(ev?.sell?.fee_usd ?? 0);
  const pnl = sellQuote - buyQuote - buyFeeUsd - sellFeeUsd;

  return [
    'TRADE OK',
    `id=${ev?.id ?? 'n/a'}`,
    `ts=${fmtTs(ev?.ts)}`,
    `symbol=${ev?.symbol ?? 'n/a'}`,
    `BUY  ${ev?.buy?.exchange ?? 'n/a'} qty=${n(ev?.buy?.executedQty)} px=${n(ev?.buy?.priceVwap)} quote=${n(buyQuote)} feeUsd=${n(buyFeeUsd)}`,
    `SELL ${ev?.sell?.exchange ?? 'n/a'} qty=${n(ev?.sell?.executedQty)} px=${n(ev?.sell?.priceVwap)} quote=${n(sellQuote)} feeUsd=${n(sellFeeUsd)}`,
    `PnL=${n(pnl)} USD`,
  ].join('\n');
}

function buildTradeWarnPrecheckText(ev) {
  return [
    'TRADE WARN PRECHECK',
    `ts=${fmtTs(ev?.ts)}`,
    `intentId=${ev?.intentId ?? 'n/a'}`,
    `symbol=${ev?.symbol ?? 'n/a'}`,
    `side=${ev?.side ?? 'n/a'}`,
    `exchange=${ev?.exchange ?? 'n/a'}`,
    `checkReason=${ev?.checkReason ?? 'n/a'}`,
  ].join('\n');
}

function initTelegramBot({cfg, app}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log.error({reason:'TELEGRAM_BOT_TOKEN missing'}, 'telegram disabled');
    return null;
  }

  const allowed = parseAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
  if (allowed.size === 0) {
    log.error({reason:'TELEGRAM_ALLOWED_USER_IDS empty'}, 'telegram disabled');
    return null;
  }

  const bot = new TelegramBot(token, {
    polling: { interval: 2000, params: { timeout: 30 } },
  });
  
  const exState = getExState();
  const exchanges = cfg.exchanges;
  if (!app || !app.executor) {
    throw new Error('telegram_bot init requires app.executor');
  }
  let pushEnabled = true;

  function isAllowed(msg) {
    return allowed.has(msg.from?.id);
  }

  function notifyAllowedUsers(text, logKey) {
    if (!pushEnabled) return;
    try {
      const ids = Array.from(allowed);
      const sends = [];
      for (const id of ids) {
        sends.push(
          bot.sendMessage(id, `<pre>${text}</pre>`, { parse_mode: 'HTML' })
        );
      }
      Promise.allSettled(sends)
        .then((res) => {
          for (const [idx, r] of res.entries()) {
            if (r.status === 'rejected') {
              log.error({ err: r.reason, userId: ids[idx] }, `${logKey} failed`);
            }
          }
        })
        .catch((err) => {
          log.error({ err }, `${logKey} aggregation failed`);
        });
    } catch (err) {
      log.error({ err }, `${logKey} handler failed`);
    }
  }

  bus.on('trade:orders_ok', (ev) => {
    notifyAllowedUsers(buildTradeOrdersOkText(ev), 'telegram trade notify');
  });

  bus.on('trade:warn_precheck', (ev) => {
    notifyAllowedUsers(buildTradeWarnPrecheckText(ev), 'telegram precheck warn notify');
  });

  // function buildStatusText() {
  //   const lines = [];
  //   lines.push(`status ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);

  //   for (const ex in exchanges) {
  //     const s = exState.getExchangeState(ex);
  //     if (!s) {
  //       lines.push(`${ex}: n/a`);
  //       continue;
  //     }

  //     // minimale, sichere Ausgabe (keine großen Objekte dumpen)
  //     const q = s.exchangeQuality ?? 'n/a';
  //     const ws = s.wsState ?? 'n/a';
  //     const reason = s.reason ? ` reason=${s.reason}` : '';
  //     const mdAge = fmtAge(s.anyMsgAt);

  //     lines.push(`${ex}: q=${q} ws=${ws} md=${mdAge} ${reason}`);
  //   }

  //   return lines.join('\n');
  // }

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

      bot.sendMessage(msg.chat.id,
        `<pre>${body}</pre>`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      log.error({ err }, 'telegram /status failed');
    }
  });

  // Minimaler Kill-Switch: setzt tradingDisabled irgendwo zentral (siehe Hinweis unten)
  bot.onText(/^\/kill$/, async (msg) => {
    if (!isAllowed(msg)) return;

    try {
      // TODO: safety latch setzen (z.B. require('../common/safety').kill(...))
      await bot.sendMessage(msg.chat.id, 'E-STOP: requested. (Not wired yet)');
      disableTrading();
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
    log.error({ err }, 'telegram polling error');
  });

  log.info({  }, 'telegram bot started');
  allowed.forEach((id) => {
    bot.sendMessage(id, 'app(re-)start');
  });
  return bot;
}

module.exports = { initTelegramBot };
