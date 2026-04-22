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

## exchanges

### mexc

protobuf protocol definitionen:
https://github.com/mexcdevelop/websocket-proto/tree/main

## AWS systemd service

Der Bot kann auf einer EC2-Instanz als `systemd`-Dienst laufen. Die Service-Vorlage liegt unter
`deploy/systemd/kryp-arb-bot.service`.

Vorbereitung auf dem Server:

```bash
cd /home/ubuntu/kryp_arb/bot
npm ci
npm run build
```

Pruefe, dass `.env` im Repo-Root vorhanden ist (`/home/ubuntu/kryp_arb/.env`, nicht im
`bot`-Unterordner) und mindestens die benoetigten Werte enthaelt:

```bash
NODE_ENV=production
EXPECTED_PUBLIC_IPS=<elastic-ip-oder-public-ip>
POSTGRES_URL=<postgres-connection-string>
```

Plus die API-Keys der aktivierten Exchanges und optional Telegram-Variablen.

Dienst installieren:

```bash
sudo cp deploy/systemd/kryp-arb-bot.service /etc/systemd/system/kryp-arb-bot.service
sudo systemctl daemon-reload
sudo systemctl enable kryp-arb-bot
sudo systemctl start kryp-arb-bot
```

Status und Logs:

```bash
systemctl status kryp-arb-bot
journalctl -u kryp-arb-bot -f
journalctl -u kryp-arb-bot -n 500 -o cat | ./node_modules/.bin/pino-pretty
```

In `NODE_ENV=production` schreibt der Bot standardmaessig JSON nach stdout. `systemd-journald`
speichert und rotiert diese Logs. Fuer eine menschenlesbare Ansicht kann die Journal-Ausgabe bei
Bedarf durch `pino-pretty` geleitet werden:

```bash
journalctl -u kryp-arb-bot -f -o cat | ./node_modules/.bin/pino-pretty
```

Nuetzliche Journal-Kommandos:

```bash
# live, raw JSON
journalctl -u kryp-arb-bot -f -o cat

# live, menschenlesbar
journalctl -u kryp-arb-bot -f -o cat | ./node_modules/.bin/pino-pretty

# live, menschenlesbar ueber npx
journalctl -u kryp-arb-bot -f -o cat | npx pino-pretty

# letzte 500 Zeilen, menschenlesbar
journalctl -u kryp-arb-bot -n 500 -o cat | ./node_modules/.bin/pino-pretty

# Logs seit heute oder seit einer Stunde
journalctl -u kryp-arb-bot --since today -o cat
journalctl -u kryp-arb-bot --since "1 hour ago" -o cat

# nur Error/Fatal-Logs anzeigen
journalctl -u kryp-arb-bot --since today -o cat | jq 'select(.level >= 50)'

# nur einen Logger anzeigen, z.B. executor
journalctl -u kryp-arb-bot --since today -o cat | jq 'select(.name == "executor")'

# Journal-Plattenverbrauch pruefen
journalctl --disk-usage
```

Journal-Limits setzen:

Da der Bot in Production nach stdout schreibt, sollte `systemd-journald` begrenzt werden:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo nano /etc/systemd/journald.conf.d/10-kryp-arb.conf
```

Inhalt:

```ini
[Journal]
Storage=persistent
SystemMaxUse=1G
SystemKeepFree=2G
MaxRetentionSec=14day
Compress=yes
```

Aktivieren und pruefen:

```bash
sudo systemctl restart systemd-journald
journalctl --disk-usage
systemctl status systemd-journald
```

Optional direkt aufraeumen:

```bash
sudo journalctl --vacuum-time=14d
sudo journalctl --vacuum-size=1G
```

Nach Code-Updates:

```bash
git pull
npm ci
npm run build
sudo systemctl restart kryp-arb-bot
```
