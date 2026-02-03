const TelegramBot = require('node-telegram-bot-api');

const { getCfg } = require('../common/config');
const cfg = getCfg();


if (cfg.ui.telegram_enabled) {

  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
    polling: true
  });
  console.log('telegram bot gestartet');
  
  const allowedUserIds = new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number)
  );
  
  function isAllowed(msg) {
    return allowedUserIds.has(msg.from.id);
  }
  
  bot.onText(/\/status/, (msg, match) => { 
    const chatId = msg.chat.id;
    const resp = match[1]; // the captured "whatever"
    
    // send back the matched "whatever" to the chat
    bot.sendMessage(chatId, `hallo welt user ${chatId}. resp=${resp}`); 
  });
  
  bot.onText(/\/kill/, (msg) => { /* ... */ });

  bot.on('message', (msg) => {
    const chatId = msg.chat.id;
  
    if (isAllowed(chatId)) {
      bot.sendMessage(chatId, 'Received your message. Your are allowed to control me.');
    } else {
      bot.sendMessage(chatId, 'Received your message. Your are NOT allowed to control me.');
    }
  });
}

