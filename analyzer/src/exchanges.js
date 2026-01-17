const fs = require('fs');
const path = require('path');

function loadExchanges() {
  const p = path.join(__dirname, '../config/exchanges.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function feePctToFactor(pct) {
  return pct / 100.0;
}

module.exports = {
  loadExchanges,
  feePctToFactor,
};

