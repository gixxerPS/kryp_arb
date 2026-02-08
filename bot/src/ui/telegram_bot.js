const TelegramBot = require('node-telegram-bot-api');

const { fmtNowIsoLocal } = require('../common/util');
const { getExState } = require('../common/exchange_state');
const { EXCHANGE_QUALITY } = require('../common/constants'); // ggf. Pfad anpassen

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
      reason:   s.reason ?? '',
    });
  }

  return buildTable(rows, [
    { key: 'exchange', label: 'EXCHANGE', width: 9 },
    { key: 'quality',  label: 'Q',        width: 5 },
    { key: 'ws',       label: 'WS',       width: 6 },
    { key: 'mdAge',    label: 'MSG_AGE',   width: 8 },
    { key: 'reconn',   label: 'RECONN',   width: 7 },
    { key: 'reason',   label: 'REASON',   width: 12 },
  ]);
}

function initTelegramBot(cfg) {
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

  function isAllowed(msg) {
    return allowed.has(msg.from?.id);
  }

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
    try {
      const header = `trading=${runtimestate.tradingEnabled ? 'ON' : 'OFF'}  @ ${fmtNowIsoLocal()}`;

      bot.sendMessage(msg.chat.id,
        `<pre>${header}\n\n${buildStatusTable({ exState, exchanges })}</pre>`,
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

  bot.on('polling_error', (err) => {
    log.error({ err }, 'telegram polling error');
  });

  log.info({  }, 'telegram bot started');
  return bot;
}

module.exports = { initTelegramBot };


