# kryp_arb
krypto arbitrage

- postgreSQL datenbank

## postgreSQL

- als datei gespeicherte query ausfuehren:

```bash
psql postgresql://arbuser:pass@localhost:5432/arb -f queries/test_queries.sql;
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
