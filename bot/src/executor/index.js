const binance = require('./adapter/binance_ws');

await binance.init(cfg);
const balances = await binance.getStartupBalances(assets);
binance.subscribeUserData(onUserEvent);
