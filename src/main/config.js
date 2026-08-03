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
    // Bug-Report (2026-08): eine reine Modifier-Kombi ohne dritte Taste kann
    // mit OEM-Laptop-Shortcuts kollidieren (analog zum AltGr-Fall, den
    // holdWatcher.js schon behandelt - z.B. meldete ein Nutzer, dass ein
    // Fn+Win-Funktionstasten-Kombo Ctrl+Alt am OS synthetisiert und damit
    // ungewollt ein Diktat startet). Kein pauschaler Fix ohne die genaue
    // Hardware moeglich - wer das trifft, sollte in den Einstellungen auf
    // eine Kombi MIT Haupttaste umstellen (z.B. "Control+Alt+Space"), die
    // kollidiert nicht mit reinen Modifier-Synthesen.
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
    // Turbo statt Full (Nutzer-Feedback: Kosten-Dashboard zeigte Whisper als
    // groessten Kostentreiber): auf Groq $0,04/h statt $0,111/h - fast 3x
    // guenstiger, WER-Verlust ist fuer diktierte Alltagssaetze kaum spuerbar
    // und wird von der Cleanup-Runde ohnehin nachgeglaettet.
    speechModel: 'openai/whisper-large-v3-turbo',
    cleanupModel: 'deepseek/deepseek-v4-flash',
    // Direkter OpenRouter-Call aus dem Main-Prozess fuer minimale Latenz
    // (Sable2 D14). Lokal in config.json, nie an den Renderer gereicht.
    openRouterApiKey: '',
    // Bubble ein-/ausblenden (Nutzer-Feedback): false blendet die Pille nie
    // ein, Diktat (Aufnahme/STT/Paste) laeuft unveraendert weiter - nur ohne
    // visuelle Anzeige, siehe dictationRouter.js.
    bubbleEnabled: true,
    // Nutzerwunsch: statt komplett zu verschwinden, bleibt die Pille als
    // kleiner schwarzer Punkt staendig sichtbar (place "resting") - Klick
    // darauf startet ein Diktat genauso wie der Shortcut. Default aus, weil
    // eine dauerhaft sichtbare Pille nicht jeder will (siehe dictationRouter.js).
    idleBubbleEnabled: false,
    // Kurzer Ton bei Start/Ende der Aufnahme (Nutzer-Feedback: hoerbar merken,
    // dass zugehoert wird, ohne auf die Bubble zu schauen) - synthetisiert im
    // Renderer, kein Audio-Asset. Default aus: nicht jeder will einen Piepton
    // bei jedem Diktat.
    sounds: { enabled: false, volume: 0.6 },
  },
  general: {
    // true: normaler Start (Doppelklick/Windows-Suche, nicht --hidden-
    // Autostart) zeigt die Settings - sonst landet die App unsichtbar im
    // Tray und ein Erststart wirkt wie "nichts passiert" (Nutzer-Feedback
    // 2026-07-29). In den Settings selbst wieder abschaltbar, wer das
    // Wispr-Flow-Prinzip (stiller Start) will.
    showWindowOnStartup: true,
    // Onboarding (Wispr-Flow-Vorbild): Mikro-/Shortcut-Test + Live-Demo beim
    // allerersten Start. false = noch nicht durchlaufen -> Ueberlagerung geht
    // vor dem normalen Shell auf. Ueber "Tutorial erneut anzeigen" in den
    // Einstellungen jederzeit manuell zuruecksetzbar.
    onboardingCompleted: false,
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
  const voice = {
    ...DEFAULTS.voice,
    ...parsed.voice,
    sounds: { ...DEFAULTS.voice.sounds, ...(parsed.voice && parsed.voice.sounds) },
  };
  // Einmalige Migration (Nutzer-Feedback: Kosten-Dashboard): der alte Default
  // 'openai/whisper-large-v3' steht in bereits installierten config.json-
  // Dateien fest, ohne dass es je ein UI-Feld dafuer gab - jeder gespeicherte
  // alte Wert ist also garantiert der frühere Default, nie eine bewusste
  // Nutzerwahl, daher ohne Rueckfrage auf die guenstigere Turbo-Variante heben.
  if (voice.speechModel === 'openai/whisper-large-v3') voice.speechModel = DEFAULTS.voice.speechModel;
  return {
    hotkeys: { ...DEFAULTS.hotkeys, ...parsed.hotkeys },
    voice,
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
