# MASTER PROMPT — Riff wird eine echte App (Wispr-Flow-Klasse)

> Ausgangslage: Riff hat einen erstklassigen Diktier-Kern (Hold/Toggle, Groq-
> Whisper, Cleanup, Clipboard-Paste, Pro-Codes) und ein 540×640-Fenster mit
> **nur Einstellungen**. Wispr Flow hat denselben Kern — plus ein Zuhause:
> Profil, Verlauf, Insights, Wörterbuch, Snippets, Stil, Transforms,
> Scratchpad, Konto. Diese Lücke ist keine Design-, sondern eine
> Produkt-Lücke: der Nutzer sieht nie, was Riff für ihn getan hat.
>
> Auftrag: aus dem Werkzeug ein Produkt machen — ohne den Kern zu gefährden.

---

## 1 · Team Assembly

Dieses Vorhaben wird von einem Weltklasse-Team gebaut:

| Rolle | Verantwortung in diesem Projekt |
|---|---|
| **Product Vision (Jobs)** | Warum existiert jede Seite? Eine Seite ohne Job wird gelöscht, nicht gebaut. |
| **Design Lead (Rams)** | Riffs eigene Sprache (dunkel #0a0a0c + Terracotta #d97757), nicht Wisprs Creme-Teal. Struktur kopieren, Identität behalten. |
| **UX Engineer** | 8 Views in einem Fenster, Navigation in <1 Klick, kein Modal-Dschungel, Tastatur bedienbar. |
| **Data Architect** | Ein Speicher, eine Wahrheit. Jede Zahl in Insights ist aus echten Ereignissen berechnet — keine erfundene Metrik. |
| **Latency Engineer** | Der Diktier-Hot-Path bleibt unangetastet schnell. Neue Features dürfen den Paste nie verzögern. |
| **Security Engineer** | Passwörter: scrypt + Salt. Renderer: `connect-src 'none'`, alles über IPC. Kein Klartext-Secret im Renderer. |
| **Honesty Officer** | Erfundene Statistik = Produktlüge. Was nicht messbar ist, wird nicht angezeigt. |

---

## 2 · Maximierungsziele

### A · Feature-Parität zum Screenshot (Must-Hit)
1. **Dictation** — „Welcome back, <Name>", Aktionsbanner, Stat-Panel (Wörter total / WPM / Streak), Verlauf nach Tagen gruppiert, Suche, Kopieren pro Eintrag, Löschen.
2. **Insights** — WPM-Gauge mit ehrlicher Referenz, „Fixes made by Riff" (Cleanup-Korrekturen + Wörterbuch-Treffer getrennt), Gesamtwörter + Monatsvergleich, App-Nutzung nach Kategorie mit Balken, Streak-Heatmap über 16 Wochen.
3. **Dictionary** — eigene Begriffe/Namen, Add/Delete, fließen in den Cleanup-Prompt ein → Whisper-Fehlschreibungen verschwinden dauerhaft.
4. **Snippets** — „meine E-Mail" → `mikus.jaydenx@gmail.com`. Gesprochener Trigger wird beim Diktieren ersetzt.
5. **Style** — pro Kontext (Persönlich / Arbeit / E-Mail / Sonstiges) drei Grammatiken (Formal · Casual · Very casual) + Auto-Cleanup-Schalter. Kontext = fokussierte App.
6. **Transforms** — benannte Prompt-Presets mit globalem Hotkey: markierten Text irgendwo im System umschreiben lassen. Defaults „Polish" + „Prompt Engineer", eigene anlegbar.
7. **Scratchpad** — Notizen, die man diktieren kann; anlegen/bearbeiten/löschen.
8. **Konto** — Registrieren + Anmelden gegen `halovisionai.cloud/riff`, Tier-Badge, Wortkontingent-Karte, Pro-Code einlösen.
9. **Settings** — alles Bestehende (Shortcut-Recorder, Sprache, Key, Autostart, Neustart/Beenden) als gleichwertige Seite, nichts verloren.

### B · Datenwahrheit
10. Jede Insights-Zahl leitet sich aus `history` ab — ein Eintrag pro Diktat mit `ts`, `app`, `raw`, `text`, `words`, `durationMs`, `mode`.
11. WPM = **Median** über echte Sessions (nicht Mittelwert — ein 3-Wort-Diktat mit 0,4 s verzerrt jeden Mittelwert).
12. Keine „Top 0,1 %"-Behauptung. Referenz ist der messbare Vergleich: Tippen ≈ 40 WPM.
13. Streak = aufeinanderfolgende Kalendertage mit ≥1 Diktat, aus denselben Daten wie die Heatmap. Eine Quelle, zwei Darstellungen.

### C · Kern-Integrität (Nicht-Verhandelbar)
14. Der Diktier-Pfad bleibt latenz-neutral: Store-Schreibvorgänge passieren **nach** dem Paste, Foreground-Abfrage läuft parallel zur Aufnahme.
15. Kein Feature darf ein Diktat scheitern lassen: Store kaputt, Konto offline, Transform-LLM tot → Diktat läuft trotzdem durch.
16. Kein Netzwerkzwang. Ohne Login funktioniert **alles** außer Konto-Sync.

### D · Sicherheit & Vertrauen
17. Passwort-Hashing scrypt (N=16384) + 16-Byte-Salt, Vergleich `timingSafeEqual`. Nie Klartext, nie MD5/SHA-1.
18. Session-Token 32 Byte aus `randomBytes`, nur im Main-Prozess/config.json — der Renderer sieht ihn nie.
19. Renderer-CSP bleibt `default-src 'none'` + `connect-src 'none'`: die UI kann per Konstruktion nicht nach Hause telefonieren.
20. Rate-Limiting auf Auth-Endpoints (bestehende `ratelimit.js` wiederverwenden) + Verzögerung bei Fehlversuchen.

### E · Handwerk
21. Null neue npm-Dependencies. Node-Stdlib (`fs`, `crypto`, `node:sqlite`) und Electron reichen — jede Dependency ist ein 3-Uhr-nachts-Risiko.
22. Kein Framework im Renderer: dieselbe Plain-HTML/CSS/JS-Grammatik wie der Rest von Riff.
23. Ein Modul, ein Job: `store` speichert, `insights` rechnet, `account` authentifiziert, `llm` telefoniert, `transforms` transformiert.

---

## 3 · Cross-Discipline Synergien

### Synergie 1 · Dictionary + Cleanup = selbstheilende Transkription
Das Wörterbuch ist keine Liste zum Angucken, sondern **Prompt-Material**. Die
Begriffe gehen als „diese Schreibweisen sind korrekt" in denselben
Cleanup-Call, der ohnehin schon läuft.
→ **Wirkung:** Eigennamen-Fehler verschwinden dauerhaft. **Kosten:** 0 zusätzliche Roundtrips.

### Synergie 2 · Foreground-App + Style + Insights = drei Features, eine Messung
Ein einziger `foreground`-Helper-Call pro Session liefert gleichzeitig: den
Kontext für die Stil-Wahl, die Kategorie für die App-Nutzungs-Statistik und
das Label im Verlauf.
→ **Wirkung:** 3 Features. **Kosten:** 1 Call, parallel zur Aufnahme, nie im kritischen Pfad.

### Synergie 3 · Verlauf + Transforms = Nachbearbeitung ohne Copy-Paste-Tanz
Der Verlauf hält den Text; Transforms brauchen Text. Beide teilen denselben
LLM-Pfad wie der Cleanup (`llm.js`).
→ **Wirkung:** „Polish" auf ein Diktat von vorgestern. **Kosten:** ein gemeinsames Modul statt drei HTTP-Implementierungen.

### Synergie 4 · Konto + Pro-Code + Kontingent = eine Konto-Seite, kein Billing-System
Das bestehende, live getestete Code-Redemption bleibt unangetastet (D4). Login
identifiziert nur — die Freischaltung bleibt lokal und idempotent.
→ **Wirkung:** echtes Konto. **Kosten:** kein Abo-, Zahlungs- oder Lizenzserver.

### Synergie 5 · Ehrlichkeit + Design = Vertrauen
Ein Dashboard, das „Top 0,1 %" behauptet, ohne die Vergleichsgruppe zu kennen,
verliert bei der ersten kritischen Frage seine Glaubwürdigkeit — und mit ihr
jede andere Zahl daneben.
→ **Wirkung:** jede angezeigte Zahl ist verteidigbar. **Kosten:** eine hübsche Lüge weniger.

---

## 4 · Anti-Patterns (explizit verboten)

- ❌ **Schöne Zahl ohne Quelle.** Kein Platzhalter-Diagramm, kein Demo-Datensatz, kein „12 day streak" aus dem Nichts.
- ❌ **Feature schlägt Kern.** Kein neuer Code zwischen „Taste los" und „Text steht da".
- ❌ **Wisprs Farben.** Struktur kopieren ist Lernen, Palette kopieren ist Kopieren.
- ❌ **SQLite im Client.** `better-sqlite3` = native Rebuilds = Guardians electron-builder-Hölle. JSON reicht für 500 Verlaufseinträge.
- ❌ **Login als Pflicht-Tor.** Ein Diktiertool, das ohne Netz nicht tippt, ist kaputt.
- ❌ **Ein 3000-Zeilen-`app.js`.** Views bekommen je eine Render-Funktion, kein Spaghetti-Router.

---

## 5 · Architektur

```
Main-Prozess (neu)                    Renderer (neu)
├── store.js       data.json          src/renderer/app/
├── insights.js    rechnet            ├── index.html   Sidebar + 9 Views
├── account.js     Auth-Client        ├── app.css      Riff-Sprache, dunkel
├── llm.js         ein HTTP-Pfad      ├── app.js       Render pro View
├── transforms.js  Hotkey + Runner    └── preload.js   riff.* API
└── appWindow.js   1120×760

Pipeline (angepasst, nicht ersetzt)   Server (websites/riff)
├── dictationRouter  Timing/App/History   └── server/auth.js  users+sessions
├── transcriptCleanup  Dictionary+Style       scrypt, Bearer-Token
└── dictationEngine    Snippet-Expansion
```

## 6 · KPI-Framework

| Metrik | Baseline (heute) | Ziel | Messung |
|---|---|---|---|
| Sichtbare App-Oberfläche | 1 Seite (Settings) | 9 Views | Klick durch die Sidebar |
| Diktat-Latenz (Taste los → Text) | ~1,5–3 s | unverändert | vor/nach demselben Satz |
| Erfundene Zahlen in der UI | — | **0** | jede Zahl auf `history` zurückführbar |
| Neue npm-Dependencies | 0 | **0** | `package.json` diff |
| Diktat funktioniert offline/ohne Login | ja | ja | Netz trennen, diktieren |
| Passwort-Speicherung | — | scrypt+Salt | `auth.js` Review |

## 7 · Reihenfolge

1. `store.js` + `insights.js` (Fundament — ohne Daten ist jede UI Attrappe)
2. Pipeline-Hooks (ab hier entstehen echte Daten)
3. `llm.js`-Extraktion + Dictionary/Style/Snippets-Wirkung
4. `appWindow.js` + Renderer (9 Views)
5. `transforms.js` + globale Hotkeys
6. Server-`auth.js` + `account.js`
7. Verifikation: App starten, jede View öffnen, echtes Diktat, Zahlen prüfen

**Definition of Done:** Die App startet, alle 9 Views rendern mit echten
Daten, ein Diktat erzeugt einen Verlaufseintrag, der die Insights bewegt, ein
Transform schreibt markierten Text um, Registrieren+Anmelden läuft gegen den
echten Server — und der Diktier-Kern ist messbar nicht langsamer geworden.
