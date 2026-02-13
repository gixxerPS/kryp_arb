# kryp_arb/bot

## config

- symbols.json
  fuer diese symbole werden an den exchanges L2 marktdaten abonniert
- exchanges.json
  enthaelt angaben zu ordergebuehren und ob eine exchanges fuer marktdaten und trading freigegeben wird
- bot.json
  enthalt u.a. die symbole die tatsaechlich gehandelt werden soll. 
  
Anmerkungen: 
- durch die trennung der symbole in symbols.json und bot.json ist es moeglich 
  den bot laufen zu lassen und trade chancen zu ermitteln ohne dass sie aktiv gehandelt werden
- diese symbole sind canonical und koennen intern spaeter gemapped werden. hintergrund: binance ermoeglicht 
  in EU nur handel mit USDC also wird hierfuer bspw aus AXS_USDT -> AXS_USDC (fuer marktdaten abo und orders)