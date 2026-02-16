// bot/src/collector/parsers/binance_depth.js
const { toNumLevels } = require('../../common/util');

const { getLogger } = require('../../common/logger');
const log = getLogger('collector').child({ exchange: 'binance', sub:'parser' });

const { getCanonFromStreamSym } = require('../../common/symbolinfo');

/**
 * sample raw:
 * {
 *   stream: 'metusdt@depth10@100ms',
 *   data: {
 *     lastUpdateId: 194692000,
 *     bids: [
 *       [Array], [Array],
 *       [Array], [Array],
 *       [Array], [Array],
 *     ],
 *     asks: [
 *       [Array], [Array],
 *       [Array], [Array],
 *       [Array], [Array],
 *     ]
 *   }
 * }
 *
 */
function parseBinanceDepthMessage(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || !parsed.stream || !parsed.data) return null;

  const bids = Array.isArray(parsed.data.bids) ? toNumLevels(parsed.data.bids) : [];
  const asks = Array.isArray(parsed.data.asks) ? toNumLevels(parsed.data.asks) : [];
  if (bids.length === 0 || asks.length === 0) return null;
  const symbol = getCanonFromStreamSym(parsed.stream, 'binance');
  if (!symbol) return null;

  return {
    symbol,
    bids,
    asks
  };
}

function makeBinanceDepthHandler({ exchange = 'binance', emit, nowMs }) {
  if (typeof emit !== 'function') throw new Error('emit must be a function');
  if (typeof nowMs !== 'function') throw new Error('nowMs must be a function');

  return function handle(raw) {
    const out = parseBinanceDepthMessage(raw);
    // log.debug({out}, 'parsed binance msg');
    if (!out) {
      log.warn({msg:`parse not successful for message`,raw}, 'parse');
      return false;
    }

    // log.info({
    //   tsMs: nowMs(),
    //   exchange,
    //   ...out,
    // }, 'emit');
    // sample:
    // { 
    //   tsMs: 1769711027486
    //   exchange: "binance"
    //   symbol: "A_USDT"
    //   bids: [ ["0.10000000","2978.60000000"],["0.09990000","52469.90000000"],...
    //   asks: [ ["0.10010000","10071.60000000"],["0.10020000","58914.50000000"],...
    // }
    //
    // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    // ACHTUNG: info von binance: 
    // // Bid levels are sorted from highest to lowest price.
    // // Ask levels are sorted from lowest to highest price.
    // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    emit('md:l2', {
      tsMs: nowMs(),
      exchange,
      ...out,
    });
    return true;
  };
}

module.exports = {
  parseBinanceDepthMessage,
  makeBinanceDepthHandler,
};
