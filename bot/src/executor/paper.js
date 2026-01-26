const bus = require('../bus');
const { getLogger } = require('../logger');

const log = getLogger('executor_paper');

module.exports = function startPaperExecutor() {
  bus.on('trade:intent', (intent) => {
    log.info(
      {
        id: intent.id,
        symbol: intent.symbol,
        route: `${intent.buyEx}->${intent.sellEx}`,
        qUsdt: Number(intent.qUsdt).toFixed(2),
        edgeNetPct: (intent.edgeNet * 100).toFixed(4),
      },
      'intent',
    );
  });
};

