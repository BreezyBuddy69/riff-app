// DictationRouter: Zustandsmaschine fuer Riffs EINEN Job - Diktat. Getrimmte
// Fassung von Sable2s router.js (websites/riff-MASTER-PROMPT.md §5/§11):
// kein Assistent-Modus, kein Weckwort, keine Bubble-im-Chat/Hologramm/TTS -
// nur Aufnahme -> Transkript -> Cleanup -> Format-Tokens -> Paste, fuer
// GENAU EINEN aktiven Session-Typ zur Zeit (Mode A "hold" oder Mode B
// "toggle").
//
// Wichtiger Unterschied zu Sable2: WEDER Hold- NOCH Toggle-Sessions enden
// ueber VAD-Sprechpausen (Master-Prompt §6.1) - Hold endet ausschliesslich
// per Loslassen, Toggle ausschliesslich per zweitem Doppel-Tap oder Klick auf
// die Haken/Kreuz-Icons der Bubble. Eine kurze Sprechpause mitten im Satz
// darf eine Aufnahme nie beenden.
const speechRecognition = require('./speechRecognition');
const transcriptCleanup = require('./transcriptCleanup');
const dictationEngine = require('./dictationEngine');
const typingEngine = require('./typingEngine');
const voiceWindow = require('./window');
const license = require('../license');
const store = require('../store');
const insights = require('../insights');
const appContext = require('../appContext');
const appWindow = require('../appWindow');
const helper = require('../helper');

const SAMPLE_RATE = 16000; // Whisper-Standard
// Harte Obergrenze fuer EINE Aufnahme (uebernommen aus Sable2 D28) - ohne die
// laeuft eine Aufnahme unbegrenzt weiter, wenn eine klemmende Taste oder ein
// vergessener Toggle-Modus niemand sie beendet.
const MAX_CAPTURE_MS = 5 * 60 * 1000;
// Nutzerwunsch: fuehlte sich traege an ("wartet 5 Sek zum Wegfaden") - war
// vorher 1400ms. ACHTUNG bei zukuenftigen Latenz-Beschwerden: der weit
// groessere Anteil der gefuehlten Wartezeit ist fast immer die STT+Cleanup-
// Netzwerk-Rundreise waehrend phase='thinking' (siehe finish() unten), nicht
// dieser Timer hier - der laeuft erst NACH dem Paste.
const IDLE_HIDE_MS = 700;
const ERROR_HIDE_MS = 6000;
// Nutzerwunsch: der zweite Netzwerk-Roundtrip (Cleanup-LLM) kostet spuerbare
// Latenz und lohnt sich bei kurzen Aeusserungen kaum - Schwelle deutlich
// angehoben (war 3 Woerter, praktisch "nie skip") auf "ein bis zwei kurze
// Saetze bleiben roh, ab ~drei Saetzen greift die Bereinigung".
const SKIP_CLEANUP_MAX_WORDS = 25;
// Whisper halluziniert auf Stille/Rauschen zuverlaessig Standardphrasen
// ("Vielen Dank", "Amen", "Untertitelung...") statt leer zu bleiben - ein
// Bug-Report (2026-07-30): Aufnahme ohne Sprache hat genau das gepastet.
// RMS-Schwelle auf dem rohen Int16-PCM faengt das VOR dem STT-Call ab -
// kein Text, kein Roundtrip, kein Verlaufseintrag.
// ponytail: fester Schwellwert, keine Mikrofon-Kalibrierung - hochsetzen,
// falls ein leiser Mikrofon-Pegel echte leise Sprache faelschlich verwirft.
// isSilence/isSpeech/isHallucination sind reine Funktionen in silenceFilter.js
// (test/check.js prueft sie unter nacktem Node) - hier steht nur noch die
// Pipeline, die sie verwendet.
const { isSpeech, isHallucination } = require('./silenceFilter');

let cfg = null;

let kind = null;       // 'hold' | 'toggle' | null (keine aktive Session)
let phase = 'idle';    // 'idle' | 'listening' | 'thinking' | 'error'
let pcmChunks = [];
let hideTimer = null;
let captureCapTimer = null;
// Session-Telemetrie fuer Verlauf/Insights (Master-Prompt §3 Synergie 2).
// sessionApp wird beim Start PARALLEL zur Aufnahme geholt - der Helper-Call
// darf nie zwischen "Taste los" und "Text steht da" liegen.
let sessionStartedAt = 0;
let sessionApp = { app: '', title: '' };

function isActive() { return kind !== null; }
function getKind() { return kind; }

function sendUi(partial = {}) {
  voiceWindow.send('voice:ui-state', { kind, phase, errorText: '', ...partial });
}

// Statt komplett zu verschwinden, faellt die Pille bei aktivem
// voice.idleBubbleEnabled auf den kleinen Ruhezustand zurueck (Nutzerwunsch) -
// bleibt sichtbar+klickbar, ein Klick startet ein Diktat genau wie der
// Shortcut (siehe voice.js: Klick ruft dieselbe confirmToggle()-IPC wie der
// Haken-Button). Ohne die Einstellung unveraendertes Verhalten: hide().
function restingOrHide() {
  if (cfg.voice.idleBubbleEnabled && cfg.voice.bubbleEnabled !== false) {
    phase = 'resting';
    voiceWindow.show({ size: 'mini' });
    voiceWindow.setInteractive(true);
    sendUi();
  } else {
    voiceWindow.hide();
  }
}

function scheduleHide(ms) {
  clearHideTimer();
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (phase === 'idle' || phase === 'error') restingOrHide();
  }, ms);
}
function clearHideTimer() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function armCaptureCap() {
  clearCaptureCap();
  captureCapTimer = setTimeout(() => {
    captureCapTimer = null;
    if (!kind) return;
    console.warn(`[voice] Aufnahmelimit von ${MAX_CAPTURE_MS / 1000}s erreicht - beende Aufnahme.`);
    finish();
  }, MAX_CAPTURE_MS);
}
function clearCaptureCap() {
  if (captureCapTimer) { clearTimeout(captureCapTimer); captureCapTimer = null; }
}

function beginSession(newKind) {
  if (!cfg || !cfg.voice.enabled || kind) return false;
  if (!license.canDictate(cfg)) {
    phase = 'error';
    if (cfg.voice.bubbleEnabled !== false) voiceWindow.show({ size: 'error' });
    sendUi({ errorText: `Wochenlimit erreicht (${license.WEEKLY_LIMIT} Wörter). Code einlösen in den Einstellungen für unbegrenztes Diktieren.` });
    scheduleHide(ERROR_HIDE_MS);
    return false;
  }
  clearHideTimer();
  kind = newKind;
  phase = 'listening';
  pcmChunks = [];
  sessionStartedAt = Date.now();
  sessionApp = { app: '', title: '' };
  // Fire-and-forget: laeuft waehrend gesprochen wird. Kommt die Antwort nicht
  // (Helper beschaeftigt/tot), bleibt der Verlaufseintrag eben ohne App-Label -
  // ein Diktat scheitert daran nie.
  helper.request('foreground', {}, 3000).then(
    (info) => { sessionApp = { app: info.app || '', title: info.title || '' }; },
    () => {},
  );
  armCaptureCap();
  // Toggle-Bubble bekommt Haken/Kreuz-Icons und braucht dafuer die breitere
  // 'toggle'-Groesse + wird dafuer kurz klickbar - Hold-Bubble bleibt bei
  // 'normal' und immer click-through (Master-Prompt §6.6). bubbleEnabled
  // false (Nutzer-Feedback) zeigt sie nie - Diktat funktioniert unveraendert,
  // nur ohne Anzeige (die Bubble bleibt fuer die Mikrofon-Aufnahme trotzdem
  // erzeugt/geladen, sie wird nur nie .show()n).
  if (cfg.voice.bubbleEnabled !== false) {
    voiceWindow.show({ size: newKind === 'toggle' ? 'toggle' : 'normal' });
    voiceWindow.setInteractive(newKind === 'toggle');
  }
  sendUi();
  playCue('start');
  voiceWindow.send('voice:command', {
    type: 'start-capture',
    deviceId: cfg.voice.audioDeviceId || undefined,
    sampleRate: SAMPLE_RATE,
    noiseSuppression: cfg.voice.noiseSuppression,
  });
  return true;
}

// Kurzer synthetischer Ton (kein Audio-Asset, siehe voice.js im Renderer) -
// Nutzer-Feedback: man soll auch ohne Blick auf die Bubble hoeren, ob Riff
// gerade zuhoert. Faehrt selbst nie den Hot-Path aus - ein IPC-send() wirft
// nie synchron.
function playCue(cueName) {
  if (!cfg.voice.sounds.enabled) return;
  voiceWindow.send('voice:command', { type: 'play-cue', cue: cueName, volume: cfg.voice.sounds.volume });
}

// ---------- Mode A: Halten ----------
function startHold() { return beginSession('hold'); }
function endHold() { if (kind === 'hold') finish(); }

// ---------- Mode B: Doppel-Tap / Maus-Bestaetigung ----------
// EIN Aufruf deckt beide Rollen ab: keine Session aktiv -> starten; eine
// Toggle-Session laeuft -> bestaetigen+verarbeiten (identisch zum
// Haken-Klick). toggleWatcher.js unterscheidet nicht zwischen den beiden
// Faellen - das entscheidet einzig der hier bekannte Session-Zustand.
function toggleFlow() {
  if (kind === 'toggle') finish();
  else beginSession('toggle');
}

// Kreuz-Klick in der Bubble (Master-Prompt §6.6/§6.1) - Aufnahme verwerfen,
// NICHT verarbeiten. Nur fuer Mode B sinnvoll (Mode A hat keine Buttons).
function cancelToggle() {
  if (kind !== 'toggle') return;
  clearCaptureCap();
  kind = null;
  pcmChunks = [];
  phase = 'idle';
  voiceWindow.send('voice:command', { type: 'stop-capture' });
  voiceWindow.setInteractive(false);
  voiceWindow.resize('normal');
  sendUi();
  scheduleHide(IDLE_HIDE_MS);
}

function onPcmChunk(buf) {
  if (kind) pcmChunks.push(Buffer.from(buf));
}

// VAD-Events werden bewusst NICHT zum Sessionende genutzt (siehe Datei-
// Kommentar oben) - Riff braucht hier fuer v1 nichts weiter zu tun. Bleibt
// als No-Op-Hook stehen, weil main.js/preload.js das Ereignis ohnehin vom
// Renderer bekommen (Streaming-Cleanup, Master-Prompt §6.4, baut spaeter
// direkt hierauf auf).
function onVadEvent() {}

async function finish() {
  if (!kind) return;
  clearCaptureCap();
  const mode = kind;
  const durationMs = sessionStartedAt ? Date.now() - sessionStartedAt : 0;
  kind = null;
  phase = 'thinking';
  voiceWindow.setInteractive(false);
  voiceWindow.resize('normal'); // Haken/Kreuz sind ab hier weg, egal ob es eine Toggle- oder Hold-Session war
  sendUi();
  playCue('end');
  voiceWindow.send('voice:command', { type: 'stop-capture' });

  const buf = Buffer.concat(pcmChunks);
  pcmChunks = [];
  if (!isSpeech(buf, SAMPLE_RATE)) {
    phase = 'idle';
    sendUi();
    scheduleHide(IDLE_HIDE_MS);
    return;
  }

  const asr = await speechRecognition.transcribe(cfg, buf, SAMPLE_RATE, { partial: false });
  if (!asr.ok || !asr.text.trim()) {
    phase = 'error';
    voiceWindow.resize('error');
    sendUi({ errorText: 'Spracherkennung fehlgeschlagen. Bitte später erneut versuchen.' });
    scheduleHide(ERROR_HIDE_MS);
    return;
  }
  if (isHallucination(asr.text)) {
    phase = 'idle';
    sendUi();
    scheduleHide(IDLE_HIDE_MS);
    return;
  }

  // Kurze Aeusserungen (einzelne Woerter/Befehle) enthalten so gut wie nie
  // Fuellwoerter oder Versprecher, die die Cleanup-Runde lohnen wuerden - der
  // komplette zweite Netzwerk-Roundtrip wird uebersprungen, roher Text direkt
  // gepastet (groesster Hebel gegen die gefuehlte Diktier-Latenz bei kurzen
  // Kommandos).
  const wordCount = asr.text.trim().split(/\s+/).length;
  const category = appContext.categorize(sessionApp.app);
  const styles = store.styles;
  const dictionary = store.dictionary;
  // autoCleanup aus: Rohtranskript wird gepastet (Nutzer will exakt das
  // Gesprochene, ohne Modell dazwischen) - spart auch den zweiten Roundtrip.
  const skipCleanup = wordCount <= SKIP_CLEANUP_MAX_WORDS || styles.autoCleanup === false;
  const cleanedText = skipCleanup
    ? asr.text
    : (await transcriptCleanup.clean(cfg, asr.text, appContext.cleanupExtras(styles, category, dictionary, asr.text))).text;
  license.recordWords(cfg, cleanedText);
  const pastedText = await paste(cleanedText);

  phase = 'idle';
  sendUi();
  scheduleHide(IDLE_HIDE_MS);

  // Erst NACH dem Paste protokollieren - der Verlauf darf den Hot-Path nie
  // verlaengern (Master-Prompt §2 C14).
  try {
    store.addHistory({
      mode,
      app: sessionApp.app,
      appTitle: sessionApp.title,
      appCategory: category,
      raw: asr.text.trim(),
      text: pastedText.trim(),
      words: (pastedText.match(/\S+/g) || []).length,
      durationMs,
      fixes: skipCleanup ? 0 : insights.countFixes(asr.text, cleanedText),
      dictFixes: skipCleanup ? 0 : insights.countDictFixes(asr.text, cleanedText, dictionary),
    });
    store.learnWords(cleanedText, dictionary);
    appWindow.notifyDataChanged();
  } catch (err) {
    console.warn('[voice] Verlaufseintrag fehlgeschlagen:', err.message);
  }
}

// Format-Tokens + "letzten Satz loeschen" aufloesen und aufeinanderfolgende
// Text-Ops zu EINEM String buendeln - ein einziger Paste pro Aeusserung
// (Sable2 D25, Wispr-Prinzip) statt Helper-Roundtrip pro Op.
// Gibt den tatsaechlich eingefuegten Text zurueck (mit aufgeloesten Format-
// Tokens und Snippets) - genau der gehoert in den Verlauf, nicht der
// Zwischenstand vor der Aufloesung.
async function paste(text) {
  const ops = dictationEngine.resolveDictation(text, { snippets: store.snippets });
  let pending = '';
  let pasted = '';
  const flush = async () => {
    if (pending) { await typingEngine.typeText(pending); pasted += pending; pending = ''; }
  };
  for (const op of ops) {
    if (op.kind === 'delete-last-segment') {
      await flush();
      await typingEngine.deleteLastSegment();
    } else if (op.value) {
      pending += op.value;
    }
  }
  await flush();
  return pasted;
}

// Renderer-lokaler Fehler (z.B. getUserMedia abgelehnt).
function onLocalError(text) {
  clearCaptureCap();
  kind = null;
  pcmChunks = [];
  phase = 'error';
  voiceWindow.setInteractive(false);
  const errorText = String(text || 'Mikrofon nicht verfügbar');
  voiceWindow.resize('error');
  sendUi({ errorText });
  scheduleHide(ERROR_HIDE_MS);
}

function init({ cfgRef }) {
  cfg = cfgRef;
  voiceWindow.allowMicPermission();
  restingOrHide(); // zeigt beim Start sofort den Ruhezustand, falls aktiviert
}

// Wird nach settings:save gerufen (main.js) - wer idleBubbleEnabled gerade
// erst anschaltet, soll den Ruhezustand sofort sehen, nicht erst nach dem
// naechsten Diktat. Waehrend eine Session laeuft (kind gesetzt) nicht
// eingreifen, die regelt ihre Anzeige selbst zu Ende.
function syncIdleBubble() {
  if (kind) return;
  restingOrHide();
}

module.exports = {
  init, startHold, endHold, toggleFlow, cancelToggle,
  onPcmChunk, onVadEvent, onLocalError,
  isActive, getKind, syncIdleBubble,
};
