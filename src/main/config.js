// Konfiguration: config.json im Projekt-Root (Dev) bzw. %APPDATA%\Riff
// (gepackt) - siehe CONFIG_PATH unten, gleiches Zwei-Pfade-Prinzip wie
// Sable2 (websites/riff-MASTER-PROMPT.md §5: Fork, keine Neuerfindung).
// Deutlich kleineres Schema als Sable2s config.js: Riff hat keinen Agenten,
// keine Circle/Summon/Act-Routen, kein Ollama/Vision/WebSearch - nur die
// Diktat-Sektion ueberlebt den Fork.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  hotkeys: {
    // Mode A (Master-Prompt §6.1): HALTEN zum Aufnehmen, Loslassen stoppt
    // und pastet - laeuft ueber holdWatcher.js (GetAsyncKeyState), nicht
    // Electrons globalShortcut, weil das keine reinen Modifier-Kombis kann.
    flowHold: 'Control+Alt',
    // Mode B: zweimal kurz antippen startet, zweimal kurz antippen ODER
    // Klick auf Haken/Kreuz in der Bubble beendet - laeuft ueber
    // toggleWatcher.js, unabhaengig von flowHold konfigurierbar.
    flowToggle: 'Control+Alt+D',
  },
  voice: {
    enabled: true,
    // 'de' statt 'auto': Whisper mit Auto-Erkennung uebersetzt kurze
    // deutsche Saetze sporadisch ins Englische - siehe Sable2 D40.
    language: 'de',
    noiseSuppression: true,
    audioDeviceId: '', // '' = System-Standardmikrofon
    speechModel: 'openai/whisper-large-v3',
    cleanupModel: 'deepseek/deepseek-v4-flash',
    // Direkter OpenRouter-Call aus dem Main-Prozess fuer minimale Latenz
    // (Sable2 D14). Lokal in config.json, nie an den Renderer gereicht.
    openRouterApiKey: '',
  },
  general: {
    // true: normaler Start (Doppelklick/Windows-Suche, nicht --hidden-
    // Autostart) zeigt die Settings - sonst landet die App unsichtbar im
    // Tray und ein Erststart wirkt wie "nichts passiert" (Nutzer-Feedback
    // 2026-07-29). In den Settings selbst wieder abschaltbar, wer das
    // Wispr-Flow-Prinzip (stiller Start) will.
    showWindowOnStartup: true,
  },
  // D-Wortkontingent (Nutzer-Feedback 2026-07-29, Master-Prompt §6.10/§9):
  // 'free' zaehlt Woerter gegen license.WEEKLY_LIMIT, 'pro' ist unbegrenzt.
  // licenseCode bleibt lokal gespeichert, damit ein erneutes Einloesen nach
  // Reinstall (config.json ueberlebt das, siehe CONFIG_PATH) idempotent ist.
  account: {
    tier: 'free',
    licenseCode: '',
    // Konto (account.js): rein additiv zum Code-Tier. Leer = nicht angemeldet,
    // die App funktioniert davon unabhaengig vollstaendig.
    email: '',
    name: '',
    token: '',
  },
  // Transforms (transforms.js) registrieren globale Hotkeys, die markierten
  // Text in JEDER App ueberschreiben - das passiert nur nach ausdruecklicher
  // Zustimmung, deshalb Default false ("Opt in" wie im Vorbild).
  transforms: {
    enabled: false,
  },
  // weekStart = Montag 00:00 UTC der aktuellen Kontingent-Woche (ISO-String,
  // leer beim allerersten Start). license.currentQuota() rollt das still
  // weiter, sobald eine neue Woche beginnt - siehe license.js.
  quota: {
    weekStart: '',
    wordsUsed: 0,
  },
};

// Wie Sable2: Quellordner (Dev) hat config.json sichtbar neben package.json,
// gepackt landet sie im schreibbaren userData-Verzeichnis - ins asar-Archiv
// zu schreiben wuerde beim naechsten Start synchron crashen.
const CONFIG_PATH = app.isPackaged
  ? path.join(app.getPath('userData'), 'config.json')
  : path.join(__dirname, '..', '..', 'config.json');

function readRaw() {
  try {
    // BOM tolerieren (PowerShell 5.1 schreibt UTF-8 gern mit BOM).
    const BOM = String.fromCharCode(0xfeff);
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8').replace(new RegExp(`^${BOM}`), ''));
  } catch (err) {
    if (fs.existsSync(CONFIG_PATH)) {
      console.warn('[config] config.json unlesbar, nutze Defaults:', err.message);
    }
    return {};
  }
}

function writeRaw(parsed) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
}

function normalize(parsed) {
  return {
    hotkeys: { ...DEFAULTS.hotkeys, ...parsed.hotkeys },
    voice: { ...DEFAULTS.voice, ...parsed.voice },
    general: { ...DEFAULTS.general, ...parsed.general },
    account: { ...DEFAULTS.account, ...parsed.account },
    transforms: { ...DEFAULTS.transforms, ...parsed.transforms },
    quota: { ...DEFAULTS.quota, ...parsed.quota },
  };
}

function loadConfig() {
  const cfg = normalize(readRaw());
  if (!fs.existsSync(CONFIG_PATH)) writeRaw(cfg);
  return cfg;
}

function saveConfig(partial) {
  const parsed = readRaw();
  for (const key of Object.keys(partial)) {
    const incoming = partial[key];
    parsed[key] = (incoming && typeof incoming === 'object' && !Array.isArray(incoming))
      ? { ...(parsed[key] || {}), ...incoming }
      : incoming;
  }
  writeRaw(parsed);
  return normalize(parsed);
}

module.exports = { loadConfig, saveConfig, DEFAULTS, CONFIG_PATH };
