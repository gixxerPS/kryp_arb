# kryp_arb
krypto arbitrage

## Installation

### Voraussetzungen

- postgreSQL installiert
- node.js installiert

* Datenbank und Benutzer anlegen

```bash
sudo -iu postgres
createuser arbuser
createdb arb -O arbuser
psql -c "ALTER USER arbuser WITH PASSWORD 'STRONG_PASSWORD';"
psql -d arb -c "
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO arbuser;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO arbuser;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO arbuser;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO arbuser;
"
exit
```

* Tabelle anlegen

```bash
sudo -u postgres psql -d arb -f queries/schema.sql
```

* .env Datei in Projekt-Root-Verzeichnis legen mit Inhalt:

```bash
NODE_ENV=development # production | development
POSTGRES_URL=postgresql://arbuser:pass@localhost:5432/arb
TELEGRAM_BOT_TOKEN=<my_telegram_bot_token>
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
BINANCE_ED25519_PUBLIC_KEY=<my_binance_api_key>
BINANCE_ED25519_PRIVATE_KEY_FILE=/etc/krypto_arbitrage/secrets/binance-ed25519-prv.pem
EXPECTED_PUBLIC_IPS=111.222.333.444,555.666.777.888
```

* Pakete installieren

```bash
cd collector
npm install
```

* Applikation starten

```bash
cd src
node index.js
```

### .pem Schlüsselpaar erzeugen

1. Private Key erzeugen (PEM)

```bash
openssl genpkey -algorithm ED25519 -out binance-ed25519-prv.pem
```

2. Public Key ableiten (PEM)

```bash
openssl pkey -in binance-ed25519-prv.pem -pubout -out binance-ed25519-pub.pem
```

## postgreSQL

- als datei gespeicherte query ausfuehren:

(Voraussetzung: ~/.pgpass ist angelegt)

```bash
psql -h localhost -U arbuser -d arb -f queries/test_queries.sql 
```

Analyse- und Forschungsprojekt zur Identifikation von Cross-Exchange
Spot-Arbitrage-Opportunitäten im Kryptomarkt.

Das Repository ist **kein Trading-Bot**, sondern eine datengetriebene
Umgebung zur **Sammlung, Analyse und Simulation** von Arbitrage-Setups
unter realistischen Annahmen (Fees, Slippage, Ausführungsrestriktionen).

---

## Zielsetzung

- systematische Erfassung von Best-Bid / Best-Ask (BBO) Daten
- Identifikation von Marktineffizienzen zwischen Börsen
- realistische Bewertung der Profitabilität für Retail-Setups
- Reduktion von Fehlannahmen durch datenbasierte Simulation

---


## Collector

Der **Collector** ist für die kontinuierliche Datensammlung zuständig.

Merkmale:
- WebSocket-basierte Erfassung von BBO-Daten
- Downsampling auf definierte Zeitauflösung
- Speicherung in PostgreSQL
- Exchange-spezifische Logger

Ziel:
> Aufbau einer sauberen, konsistenten historischen Datenbasis
> für nachgelagerte Analysen.

---

## Analyzer

Der **Analyzer** arbeitet ausschließlich auf bereits gespeicherten Daten.

Funktionen:
- Analyse von Rohspreads (Größe, Dauer, Persistenz)
- Screening nach Volumen, Volatilität und Ineffizienz
- Simulation von Arbitrage-Trades:
  - Fees
  - Slippage
  - Cooldown / Overtrading-Schutz
- Aggregation von PnL je Route, je Symbol und insgesamt

Ziel:
> Realistische Einschätzung, **ob** und **wo** Arbitrage für
> ein Retail-Setup überhaupt sinnvoll ist.

---

## Design-Prinzipien

- **Trennung von Datensammlung und Analyse**
- **Explizite Annahmen** (keine impliziten Optimismen)
- **Reproduzierbarkeit** aller Ergebnisse
- Fokus auf **Risiken und Limitierungen**, nicht nur auf PnL

---

## Wichtige Hinweise

- Dieses Projekt ist **kein fertiger Trading-Bot**
- Ergebnisse stellen **keine Handlungsempfehlung** dar
- Live-Trading erfordert zusätzliche Aspekte:
  - Latenz
  - Orderbuch-Tiefe
  - Rebalancing
  - Exchange-Risiken

---

## Status

- Collector: stabil, erweiterbar
- Analyzer: aktiv in Entwicklung
- Execution-Bot: **nicht Teil dieses Repositories**

---

## Motivation

Cross-Exchange Arbitrage ist in großen Märkten weitgehend effizient.
Dieses Projekt untersucht systematisch, **unter welchen Bedingungen**
trotzdem noch Edge existieren kann – und wo nicht.

> Ziel ist nicht „Gewinne versprechen“, sondern **Illusionen zu zerstören**.
