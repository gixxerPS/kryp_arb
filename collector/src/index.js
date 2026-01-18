const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Client } = require('pg');
const fs = require('fs');
const log = require('./logger').getLogger('app');

const db = new Client({
  connectionString: process.env.POSTGRES_URL,
});

function loadSymbols() {
  const p = path.join(__dirname, '../config/symbols.json');
  const raw = fs.readFileSync(p, 'utf8');
  const json = JSON.parse(raw);
  return json.symbols || [];
}

async function main() {
  try {
    await db.connect();
    log.info('DB connected');

    const symbols = loadSymbols();
    log.info(`Loaded symbols=${symbols.length}`);

    // bbo daten
    require('./streams/binance')(db, symbols);
    require('./streams/bitget')(db, symbols);
    require('./streams/gate')(db, symbols);

    // orderbuch tiefe
    //require('./streams/binance_depth')(db, symbols);
  } catch (err) {
    log.error('Startup error', err);
    process.exit(1);
  }
}

main();

