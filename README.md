# Riff

Sprache = schneller als Tippen. Shortcut halten oder doppelt antippen,
sprechen, loslassen — der bereinigte Text erscheint an der Cursor-Position.

Plan: `../websites/riff-MASTER-PROMPT.md` · Entscheidungen: `DECISIONS.md`

## Starten

```
npm install
npm start
```

Vor dem ersten Diktat einen OpenRouter-API-Key eintragen: `config.json` im
Projektordner öffnen (wird beim ersten Start automatisch angelegt), Feld
`voice.openRouterApiKey` setzen, App neu starten.

## Die App

Doppelklick (oder Tray → „Riff öffnen") zeigt das Fenster mit neun Ansichten:
**Diktat** (Verlauf, Suche, Statistik) · **Insights** (WPM, Korrekturen,
App-Nutzung, Serie) · **Wörterbuch** · **Snippets** · **Stil** (pro Kontext) ·
**Transforms** (markierten Text per Hotkey umschreiben) · **Scratchpad** ·
**Konto** · **Einstellungen**. Plan und Begründungen:
`APP-MASTER-PROMPT.md`, Entscheidungen in `DECISIONS.md` (D15–D22).

Alle Daten liegen lokal (`data.json` neben `config.json`), Anmelden ist
optional — ohne Konto funktioniert alles außer der Namensanzeige.

## Hotkeys (Default, in den Einstellungen bzw. `config.json` änderbar)

- **Mode A — Halten:** `Strg+Alt` gedrückt halten, sprechen, loslassen.
- **Mode B — Doppel-Tap:** `Strg+Alt+D` zweimal kurz antippen zum Start,
  erneut zweimal antippen ODER auf Haken (übernehmen) / Kreuz (verwerfen) in
  der Bubble klicken zum Beenden.
- **Transforms** (erst nach Aktivieren in der App): `Alt+Shift+P` = Polish,
  `Alt+Shift+O` = Prompt Engineer — Text markieren, Hotkey drücken.

## Tests

```
npm test
```

Prüft die rechnende Logik (Insights-Kennzahlen, Snippet-/Format-Auflösung,
Kontext-Erkennung) ohne Electron.

## Entwicklungshinweis

`ELECTRON_RUN_AS_NODE=1` in der Shell lässt `electron .` als reinen
Node-Prozess laufen (kein `app`/`screen`-Modul) — vor `npm start` prüfen bzw.
mit `env -u ELECTRON_RUN_AS_NODE npm start` umgehen.
