// Halten-zum-Diktieren-Watcher (D26): pollt den Diktat-Shortcut (Default
// "Control+Alt") ueber den Helper (GetAsyncKeyState, gleiches Prinzip wie das
// fruehere PTT-Polling D16). Noetig, weil Electrons globalShortcut weder
// reine Modifier-Kombis ("Control+Alt") registrieren kann noch ein Key-Up-
// Ereignis kennt - beides braucht Halten-zum-Aufnehmen zwingend.
//
// Zustandsmaschine:
//   idle      --Kombination >= HOLD_START_MS ununterbrochen unten--> holding
//   holding   --Kombination losgelassen--> idle (+ onHoldEnd)
//   latched   = Kombination ist unten, darf aber (noch) keine Session
//               starten (zu kurz/abgelehnt) - wartet auf komplettes
//               Loslassen, verhindert Dauerfeuer.
//
// HOLD_START_MS schuetzt vor AltGr: auf deutschen Tastaturen erzeugt AltGr
// (fuer @ € { [ ...) OS-seitig Strg+Alt - ein normaler AltGr-Tastendruck ist
// aber deutlich kuerzer als die Schwelle und startet daher keine Aufnahme.
//
// Latenz-Optimierung (Nutzerwunsch: Bubble soll wie bei Wispr Flow instant
// erscheinen, gemessen ~20% langsamer): HOLD_START_MS war mit Abstand der
// groesste Batzen der Erkennungslatenz (>85% des Budgets) - eine PAUSCHALE
// Sicherheitsspanne fuer JEDEN Tastendruck, obwohl AltGr nur die EINE exakte
// Tasten-Seiten-Kombination (linke Strg + rechte Alt) erzeugen kann. Windows
// synthetisiert AltGr IMMER als genau diese Seiten-Kombi - eine bewusste
// Zwei-Hand-Kombination trifft sie so gut wie nie. HOLD_START_FAST_MS gilt
// deshalb nur, wenn (a) der konfigurierte Hotkey exakt "ctrl+alt" ist (der
// einzige AltGr-Kollisionsfall - eine Kombi mit echter Taste z.B. "ctrl+alt+d"
// kann AltGr allein nie ausloesen) UND (b) der Helper per mods_state bestaetigt,
// dass es NICHT nach der AltGr-Signatur aussieht. Bleibt die Bestaetigung aus
// (Timing, Fehler) oder sieht's nach AltGr aus, greift weiterhin der volle,
// sichere HOLD_START_MS - nie unsicherer als vorher, nur manchmal schneller.
const helper = require('../helper');

const HOLD_START_MS = 250;
const HOLD_START_FAST_MS = 50;
const POLL_IDLE_MS = 20; // war 80ms - GetAsyncKeyState ist ein einzelner nativer Call, haeufiger pollen kostet praktisch nichts
const POLL_ACTIVE_MS = 40; // reaktiv, sobald die Kombi unten ist / Session laeuft

let cfg = null;
let onHoldStart = null;
let onHoldEnd = null;

let timer = null;
let downSince = 0; // 0 = Kombination ist oben
let holdThreshold = HOLD_START_MS; // pro Druck neu bestimmt, siehe oben
let holding = false; // Session laeuft (onHoldStart wurde gefeuert)
let latched = false; // unten, aber keine Session - erst Loslassen abwarten
let lastAccel = '';
let helperKeys = '';
// Waehrend der Hotkey-Aufnahme in den Settings (D37) pausiert der Watcher -
// sonst wuerde das Druecken von "Strg+Alt" im Recorder sofort ein Diktat
// starten, statt als neue Kombination gespeichert zu werden.
let suspended = false;

// Electron-Accelerator ("Control+Alt") -> Press-Combo-Format des Helpers
// ("ctrl+alt", siehe SableHelper.ps1 $VK-Tabelle). Wird pro Poll nur bei
// geaenderter Config neu berechnet - Settings-Aenderungen wirken sofort,
// ohne dass der Watcher neu gestartet werden muss.
function keysFor() {
  const accel = (cfg.hotkeys.flowHold || '').trim();
  if (accel !== lastAccel) {
    lastAccel = accel;
    helperKeys = accel.toLowerCase().replace(/control/g, 'ctrl').replace(/\s+/g, '');
  }
  return helperKeys;
}

async function poll() {
  if (suspended || !cfg || !cfg.voice.enabled) { reset(); schedule(POLL_IDLE_MS); return; }
  const keys = keysFor();
  if (!keys) { reset(); schedule(POLL_IDLE_MS); return; }

  let down = false;
  try {
    const r = await helper.request('key_state', { keys }, 1500);
    down = !!r.down;
  } catch {
    // Helper kurz beschaeftigt/startet noch - naechster Poll versucht's wieder.
    schedule(holding ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return;
  }

  if (down) {
    if (!downSince) {
      downSince = Date.now();
      holdThreshold = HOLD_START_MS; // sicherer Default, bis mods_state (falls angefragt) das Gegenteil bestaetigt
      if (keys === 'ctrl+alt') checkAltGrFastPath();
    }
    if (!holding && !latched && Date.now() - downSince >= holdThreshold) {
      const started = onHoldStart ? onHoldStart() : false;
      if (started) holding = true;
      else latched = true; // z.B. Assistent-Session aktiv - bis zum Loslassen ignorieren
    }
    schedule(POLL_ACTIVE_MS);
    return;
  }

  // Kombination ist oben.
  if (holding && onHoldEnd) onHoldEnd();
  reset();
  schedule(POLL_IDLE_MS);
}

// Fragt den Helper einmalig, sobald die reine "ctrl+alt"-Kombi unten geht, ob
// die Links/Rechts-Belegung nach AltGr aussieht (siehe Kommentar oben an
// HOLD_START_FAST_MS). askedAt verhindert, dass eine verspaetete Antwort noch
// auf einen laengst losgelassenen/neu gedrueckten Tastendruck angewendet wird.
function checkAltGrFastPath() {
  const askedAt = downSince;
  helper.request('mods_state', {}, 500).then((m) => {
    if (downSince !== askedAt) return;
    const looksLikeAltGr = m.ctrlLeft && m.altRight && !m.ctrlRight && !m.altLeft;
    if (!looksLikeAltGr) holdThreshold = HOLD_START_FAST_MS;
  }).catch(() => {}); // Fehler/Timeout -> holdThreshold bleibt beim sicheren HOLD_START_MS
}

function reset() {
  downSince = 0;
  holding = false;
  latched = false;
}

function schedule(ms) {
  timer = setTimeout(poll, ms);
}

// onHoldStart muss true zurueckgeben, wenn wirklich eine Session gestartet
// wurde - sonst merkt sich der Watcher "abgelehnt" und wartet aufs Loslassen.
function start({ cfgRef, onHoldStart: startFn, onHoldEnd: endFn }) {
  cfg = cfgRef;
  onHoldStart = startFn;
  onHoldEnd = endFn;
  if (!timer) schedule(POLL_IDLE_MS);
}

function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
  reset();
}

function setSuspended(on) {
  suspended = !!on;
  if (suspended) reset();
}

module.exports = { start, stop, setSuspended };
