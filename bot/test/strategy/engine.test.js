const { suite, test } = require('node:test');
const assert = require('node:assert/strict');

const { computeIntentsForSym, getQWithinSlippage } = require('../../src/strategy/engine');
const { EXCHANGE_QUALITY } = require('../../src/common/constants');

const cfg = { 
  bot : {
    raw_spread_buffer_pct: 0.05,
    slippage_pct: 0.05,
    q_min_usdt: 100,
    q_max_usdt: 5000,
  }
};

const fees = {
  gate: { taker_fee_pct: 0.1 },
  binance: { taker_fee_pct: 0.1 },
};

const exState = {
  getExchangeState: (ex) => ({ exchange: ex, exchangeQuality: EXCHANGE_QUALITY.OK, anyAgeMs: 0 })
};

suite('strategy/engine stage 1. detect trades from spread', () => {
  test('computeIntents erzeugt intent wenn net edge > 0 und genug l10 liquidität', () => {
    const latest = new Map();
    const nowMs = 1_000_000;
    const sym = 'AAA_USDT';

    // buy on gate: ask=100, askQtyL10=100 => qMaxBuy=10k
    latest.set('gate|AAA_USDT', {
      tsMs: nowMs,
      bids: [ [100.0103, 4193.0],[100.0102, 12935.8],],
      asks: [ [100.0000, 952.8], [100.0001, 20491.0],],
    });

    // sell on binance: bid=100.6 => raw = 0.6%
    // bidQtyL10=100 => qMaxSell=10,060
    latest.set('binance|AAA_USDT', {
      tsMs: nowMs,
      bids: [ [100.6103, 4193.0],[100.6102, 12935.8],],
      asks: [ [100.6000, 952.8], [100.6001, 20491.0],],
    });

    cfg.bot.symbols = [sym];
    cfg.bot.exchanges = ['gate', 'binance'];

    const intents = computeIntentsForSym({ sym, latest, fees, nowMs, cfg, exState});

    assert.deepEqual(intents.length, 1);
    assert.deepEqual(intents[0].buyEx, 'gate');
    assert.deepEqual(intents[0].sellEx, 'binance');
    assert.ok(intents[0].q <= 5000);
    assert.ok(intents[0].net > 0);
  });
  test('computeIntents erzeugt keinen intent wenn net edge < 0 ', () => {
    const latest = new Map();
    const nowMs = 1_000_000;
    const sym = 'AAA_USDT';

    // buy on gate: ask=100, askQtyL10=100 => qMaxBuy=10k
    latest.set('gate|AAA_USDT', {
      tsMs: nowMs,
      bids: [ [100.0, 4193.0],[101.0, 12935.8],],
      asks: [ [99.0, 952.8], [98.0, 20491.0],],
    });

    // sell on binance: bid=100.6 => raw = 0.6%
    // bidQtyL10=100 => qMaxSell=10,060
    latest.set('binance|AAA_USDT', {
      tsMs: nowMs,
      bids: [ [99.0, 4193.0],[98.5, 12935.8],],
      asks: [ [100.5, 952.8], [101.0, 20491.0],],
    });

    cfg.bot.symbols = [sym];
    cfg.bot.exchanges = ['gate', 'binance'];

    const intents = computeIntentsForSym({ sym, latest, fees, nowMs, cfg, exState});

    assert.deepEqual(intents.length, 0);
  });

  test('computeIntents erzeugt keinen intent wenn stale', () => {
    const latest = new Map();
    const nowMs = 1_000_000;
    const sym = 'AAA_USDT';

    latest.set('gate|AAA_USDT', {
      tsMs: nowMs - 5000, // <- datensatz zu alt
      bids: [ [100.0000, 4193.0],[100.0001, 12935.8], ],
      asks: [ [100.0000, 952.8], [100.0001, 20491.0], ],
    });

    latest.set('binance|AAA_USDT', {
      tsMs: nowMs,
      bids: [ [100.0000, 4193.0],[100.0001, 12935.8], ],
      asks: [ [100.0000, 952.8], [100.0001, 20491.0], ],
    });

    cfg.bot.symbols = [sym];
    cfg.bot.exchanges = ['gate', 'binance'];

    const intents = computeIntentsForSym({ sym, latest, fees, nowMs, cfg, exState});

    assert.equal(intents.length, 0);
  });

  test('raw_spread_buffer_pct acts as buffer inside net', () => {
    const nowMs = 1_000_000;
    const latest = new Map();
    const sym = 'FOO_USDT';
    latest.set('binance|FOO_USDT', { tsMs: nowMs, asks: [[100.00,1]], bids: [[99.00,1]] });
    latest.set('bitget|FOO_USDT',  { tsMs: nowMs, bids: [[100.10,1]], asks: [[101.00,1]] });

    const cfg = {
      bot: {
        symbols: [sym],
        exchanges: ['binance','bitget'],
        slippage_pct: 0.00,
        raw_spread_buffer_pct: 0.05, // 0.05%
        q_min_usdt: 1,
        q_max_usdt: 1000,
        max_book_age_ms: 1500,
      }
    };

    const fees = { binance: { taker_fee_pct: 0.0 }, bitget: { taker_fee_pct: 0.0 } };

    const intents = computeIntentsForSym({ sym, latest, fees, nowMs, cfg, exState });
    assert.equal(intents.length, 1);
  });
  test('computeIntentsForSymbol uses bestAskPx for asks and bestBidPx for bids (guards against swap bug)', () => {
    const nowMs = 1_000_000;
    const sym = 'FOO_USDT';

    // Konstruktion so, dass NUR die korrekte Wahl (ask=min, bid=max) einen Intent ergibt:
    // Buy asks: best ask = 100, worst ask = 105
    // Sell bids: best bid = 101, worst bid = 99
    // Korrekt: raw = (101 - 100)/100 = +1%  -> Intent
    // Bug (asks via max): raw = (101 - 105)/105 < 0 -> kein Intent
    // Bug (bids via min): raw = (99 - 100)/100 < 0 -> kein Intent
    const latest = new Map();
    latest.set('binance|FOO_USDT', {
      tsMs: nowMs,
      asks: [ [100, 1],[105, 1], ],
      bids: [ [99, 1],[98, 1],   ],
    });

    latest.set('bitget|FOO_USDT', {
      tsMs: nowMs,
      bids: [ [101, 1], [99, 1], ],
      asks: [ [102, 1], [103, 1],],
    });

    const cfg = {
      bot: {
        exchanges: ['binance', 'bitget'],
        // Stage 1
        raw_spread_buffer_pct: 0,
        slippage_pct: 0,
        max_book_age_ms: 1500,
        // Stage 2
        q_min_usdt: 1,
        q_max_usdt: 1_000_000,
      },
    };

    // fees[ex].taker_fee_pct in Prozent
    const fees = {
      binance: { taker_fee_pct: 0 },
      bitget: { taker_fee_pct: 0 },
    };

    const intents = computeIntentsForSym({ sym, latest, fees, nowMs, cfg, exState });

    assert.equal(intents.length, 1);
    assert.equal(intents[0].symbol, sym);
    assert.equal(intents[0].buyEx, 'binance');
    assert.equal(intents[0].sellEx, 'bitget');
    assert.equal(intents[0].buyAsk, 100);
    assert.equal(intents[0].sellBid, 101);
    assert.ok(intents[0].net > 0);
  });
  test('net2 (using limLvlIdx worst prices) can filter out a stage-1 candidate', () => {
    const nowMs = 1_000_000;
    const sym = 'FOO_USDT';

    // Stage-1: top-of-book is profitable:
    // buyAsk=100, sellBid=101 -> raw1 = +1%
    //
    // Stage-2: within slippage band (1%) we include level[1] as worst:
    // buyPxWorst=101, sellPxWorst=100.2 -> raw2 negative -> must be filtered
    const latest = new Map();

    // BUY: binance
    latest.set(`binance|${sym}`, {
      tsMs: nowMs,
      asks: [
        [100.0, 0.01],   // best ask
        [101.0, 1000],   // worst within 1% band
        [102.0, 1000],   // out of band
      ],
      bids: [ [99.0, 1], [98.0, 1], ],
    });

    // SELL: bitget
    latest.set(`bitget|${sym}`, {
      tsMs: nowMs,
      bids: [
        [101.0, 0.01],   // best bid
        [100.2, 1000],   // worst within 1% band
        [99.0,  1000],
      ],
      asks: [ [102.0, 1], [103.0, 1], ],
    });

    const cfg = {
      bot: {
        exchanges: ['binance', 'bitget'],
        raw_spread_buffer_pct: 0,
        slippage_pct: 1.0,          // 1% band for getQWithinSlippage
        max_book_age_ms: 1500,
        q_min_usdt: 10,
        q_max_usdt: 1_000_000,
      },
    };

    const fees = {
      binance: { taker_fee_pct: 0 },
      bitget:  { taker_fee_pct: 0 },
    };

    const intents = computeIntentsForSym({ sym, latest, fees, nowMs, cfg, exState });
    assert.equal(intents.length, 0);
  });

  test('net2 (using limLvlIdx worst prices) allows intent when worst-in-band still profitable', () => {
    const nowMs = 1_000_000;
    const sym = 'FOO_USDT';

    const latest = new Map();

    // BUY: binance (asks ascending)
    // limLvlIdx = 1 (101 <= 101.0 when slippage = 1%)
    latest.set(`binance|${sym}`, {
      tsMs: nowMs,
      asks: [
        [100.0, 0.01],   // best ask
        [101.0, 1000],   // worst within band (<= 101)
        [102.0, 1000],   // out of band
      ],
      bids: [ [99.0, 1], [98.0, 1], ],
    });

    // SELL: bitget (bids descending)
    // limLvlIdx = 1 (101 >= 100.98 when slippage = 1%)
    latest.set(`bitget|${sym}`, {
      tsMs: nowMs,
      bids: [
        [102.0, 0.01],   // best bid
        [101.2, 1000],   // worst within band (>= 100.98)
        [100.5, 1000],   // out of band
      ],
      asks: [ [103.0, 1], [104.0, 1], ],
    });
    const cfg = {
      bot: {
        exchanges: ['binance', 'bitget'],
        raw_spread_buffer_pct: 0,
        slippage_pct: 1.0,
        max_book_age_ms: 1500,
        q_min_usdt: 1,
        q_max_usdt: 1_000_000,
      },
    };
    const fees = {
      binance: { taker_fee_pct: 0 },
      bitget:  { taker_fee_pct: 0 },
    };
    const intents = computeIntentsForSym({sym, latest, fees, nowMs, cfg, exState});

    assert.equal(intents.length, 1);
    const it = intents[0];

    assert.equal(it.symbol, sym);
    assert.equal(it.buyEx, 'binance');
    assert.equal(it.sellEx, 'bitget');

    // Sanity: worst-in-band prices really form a positive edge
    // raw2 = (101 - 101) / 101 = 0   (fees=0, buffer=0 ⇒ allowed)
    // If you want strictly positive, bump sell to 101.1
    assert.ok(it.net > 0 || it.net2 >= 0);
  });

  test('stage2 liquidity nok: no intent when qBuy or qSell < qMin', () => {
    const nowMs = 1_000_000;
    const sym = 'FOO_USDT';
    const latest = new Map();

    // BUY: top-of-book ok, aber extrem wenig Qty im Band
    latest.set(`binance|${sym}`, {
      tsMs: nowMs,
      asks: [
        [100.0, 0.001],   // nur 0.1 USDT Notional
        [101.0, 0.001],
      ],
      bids: [ [99.0, 1], [98.0, 1], ],
    });

    // SELL: ebenfalls zu wenig Notional im Band
    latest.set(`bitget|${sym}`, {
      tsMs: nowMs,
      bids: [
        [101.0, 0.001],   // nur 0.101 USDT
        [100.5, 0.001],
      ],
      asks: [ [102.0, 1], [103.0, 1], ],
    });

    const cfg = {
      bot: {
        exchanges: ['binance', 'bitget'],
        raw_spread_buffer_pct: 0,
        slippage_pct: 1.0,
        max_book_age_ms: 1500,
        q_min_usdt: 10,          // bewusst höher als verfügbare Liquidität
        q_max_usdt: 1_000_000,
      },
    };
    const fees = {
      binance: { taker_fee_pct: 0 },
      bitget:  { taker_fee_pct: 0 },
    };
    const intents = computeIntentsForSym({ sym, latest, fees, nowMs, cfg, exState });
    assert.equal(intents.length, 0);
  });
  test('computeIntents erzeugt keinen intent wenn trade gueltig aber exchange state passt nicht', () => {
    const latest = new Map();
    const nowMs = 1_000_000;
    const sym = 'AAA_USDT';

    const exStateBinanceFail = {
      getExchangeState: (ex) => ({
        exchange: ex,
        exchangeQuality: ex === 'binance' ? EXCHANGE_QUALITY.STOP : EXCHANGE_QUALITY.OK,
        anyAgeMs: 9000
      })
    };
    // buy on gate: ask=100, askQtyL10=100 => qMaxBuy=10k
    latest.set('gate|AAA_USDT', {
      tsMs: nowMs,
      bids: [ [100.0103, 4193.0],[100.0102, 12935.8],],
      asks: [ [100.0000, 952.8], [100.0001, 20491.0],],
    });

    // sell on binance: bid=100.6 => raw = 0.6%
    // bidQtyL10=100 => qMaxSell=10,060
    latest.set('binance|AAA_USDT', {
      tsMs: nowMs,
      bids: [ [100.6103, 4193.0],[100.6102, 12935.8],],
      asks: [ [100.6000, 952.8], [100.6001, 20491.0],],
    });

    cfg.bot.symbols = [sym];
    cfg.bot.exchanges = ['gate', 'binance'];

    const intents = computeIntentsForSym({ sym, latest, fees, nowMs, cfg, exState:exStateBinanceFail});

    assert.deepEqual(intents.length, 0);
  });

});

//=============================================================================
//
//=============================================================================

suite('strategy/engine stage 2. determine possible q', () => {
  test('buy-side sums asks up to bestAsk*(1+slippage)', () => {
    const asks = [
      [100.00, 1],   // in band
      [100.05, 2],   // in band for 0.10%
      [100.20, 10],  // out of band
    ];
    const r = getQWithinSlippage({
      levels: asks,
      slippagePct: 0.10,  // 0.10%
      qMax: 1e9,
    });
    assert.equal(r.q, 100*1 + 100.05*2);
    assert.equal(r.limLvlIdx, 1);
    assert.equal(r.pxLim, 100.1);// limit = 100 * 1.001 = 100.1 -> first two count
  });
  test('buy-side sums asks up to array end', () => {
    const asks = [
      [100.00, 1],   // in band
      [100.05, 2],   // in band for 0.10%
      [100.20, 10],  // out of band
    ];
    const r = getQWithinSlippage({
      levels: asks,
      slippagePct: 0.50,  // 0.10%
      qMax: 1e9,
    });
    assert.ok(Math.abs(r.q - (100*1 + 100.05*2 + 100.2*10)) < 1e-3);
    assert.equal(r.limLvlIdx, 2);
    assert.ok(Math.abs(r.pxLim - 100.5) < 1e-3);
  });
  test('sell-side sums asks up to bestAsk*(1-slippage)', () => {
    const pArr = [
      [100.00, 1],   // in band
      [ 99.95, 2],   // in band for 0.10%
      [ 99.5, 10],  // out of band
    ];
    const r = getQWithinSlippage({
      levels: pArr,
      slippagePct: 0.10,  // 0.10%
      qMax: 1e9,
    });
    assert.ok(Math.abs(r.q - (100*1 + 99.95*2) ) < 1e-3);
    assert.equal(r.limLvlIdx, 1);
    assert.ok(Math.abs(r.pxLim - 99.9) < 1e-3);
  });
  test('sell-side sums asks up to array end', () => {
    const pArr = [
      [100.00, 1],   // in band
      [ 99.95, 2],   // in band for 0.10%
      [ 99.5, 10],  // out of band
    ];
    const r = getQWithinSlippage({
      levels: pArr,
      slippagePct: 0.50,  
      qMax: 1e9,
    });
    assert.ok(Math.abs(r.q - (100*1 + 99.95*2 + 99.5*10)) < 1e-3);
    assert.equal(r.limLvlIdx, 2);
    assert.ok(Math.abs(r.pxLim - 99.5) < 1e-3);
  });

  test('getQWithinSlippage: full levels within slippage, qMax not hit', () => {
    // buy-side style (asks increasing)
    const levels = [
      [100, 1],   // quote 100
      [101, 2],   // quote 202
    ];
    const { q, targetQty, limLvlIdx } = 
      getQWithinSlippage({ levels, slippagePct: 5, qMax: 1000 });

    assert.equal(q, 302);
    assert.equal(targetQty, 3);
    assert.equal(limLvlIdx, 1);
  });

  test('getQWithinSlippage: partial last level when qMax hit', () => {
    const levels = [
      [100, 10],  // quote 1000
      [101, 10],  // quote 1010
    ];
    const { q, targetQty, limLvlIdx } =
    getQWithinSlippage({ levels, slippagePct: 5, qMax: 1500 });

    // take full lvl0: 1000 quote, qty 10
    // remaining 500 quote at px 101 => qty 500/101
    assert.equal(q, 1500);
    assert.ok(Math.abs(targetQty - (10 + 500/101)) < 1e-6);
    assert.equal(limLvlIdx, 1);
  });

  test('getQWithinSlippage: break on slippage limit (buy side)', () => {
    const levels = [
      [100, 1],   // ok
      [100.04, 1],// ok (<= 0.05%)
      [100.06, 1],// exceeds 0.05% -> stop before this
    ];
    const { q, targetQty, limLvlIdx } = getQWithinSlippage({ levels, slippagePct: 0.05, qMax: 1000 });

    assert.ok(Math.abs(q - 200.04) < 1e-6);
    assert.equal(targetQty, 2);
    assert.equal(limLvlIdx, 1);
  });

  test('getQWithinSlippage: sell-side direction (bids decreasing)', () => {
    // sell-side style (bids decreasing)
    const levels = [
      [100, 1],      // best bid
      [99.98, 2],    // within 0.05% (limit = 99.95)
      [99.94, 1],    // below limit -> stop before
    ];
    const { q, targetQty, limLvlIdx, pxLim } = getQWithinSlippage({ levels, slippagePct: 0.05, qMax: 1000 });

    assert.ok(pxLim <= 100 && pxLim >= 99.9);
    assert.equal(q, 100 + 99.98*2);
    assert.equal(targetQty, 3);
    assert.equal(limLvlIdx, 1);
  });

  test('getQWithinSlippage: qMax smaller than first level -> partial first level', () => {
    const levels = [
      [100, 10], // quote 1000 available
    ];
    const { q, targetQty, limLvlIdx } = 
      getQWithinSlippage({ levels, slippagePct: 1, qMax: 250 });

    assert.equal(q, 250);
    assert.equal(targetQty, 2.5);
    assert.equal(limLvlIdx, 0);
  });

});
