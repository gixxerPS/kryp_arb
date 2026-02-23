import type { ExchangeId } from './common';

export type TradeIntent = {
  id            : string;     /** unique id */
  tsMs          : number;     /** timestamp created at */
  valid_until   : Date;       /** tsMs + cfg.bot.intent_time_to_live_ms */

  symbol        : string;     /** e.g. AXS_USDT */

  buyEx         : ExchangeId; /** e.g. binance */
  sellEx        : ExchangeId; /** e.g. gate */

  q             : number;     /** expected liquidity of each leg, i.e. avg price * targetQty */
  targetQty     : number;     /** e.g. 127 [AXS] */
  net           : number;     /** net spread incl slippage worst px and fees, e.g. 0.0012 (no %!) */

  buyAsk        : number;     /** best ask px */
  sellBid       : number;     /** best bid px */

  buyPxWorst    : number;     /** worst case ask px (incl slippage) -> buy price should be better than this */
  sellPxWorst   : number;     /** worst case bid px (incl slippage) -> sell price should be better than this */
};