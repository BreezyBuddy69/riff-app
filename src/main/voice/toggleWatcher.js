// Doppel-Tap-Watcher (Mode B, Master-Prompt §6.1 in websites/riff-MASTER-
// PROMPT.md): erkennt zwei kurze Druecke derselben Tastenkombination
// innerhalb von DOUBLE_TAP_GAP_MS und meldet GENAU EIN Ereignis
// (onDoubleTap) - ob das eine Session startet oder beendet, entscheidet der
// Aufrufer (dictationRouter kennt den Session-Zustand, dieser Watcher nicht).
// Gleiches Polling-Prinzip wie holdWatcher.js (GetAsyncKeyState ueber den
// Helper), aber Kanten- statt Level-Auswertung: ein einzelnes langes Halten
// darf NIE als Tap zaehlen - sonst kaeme sich Mode A (halten) mit Mode B
// (doppelt tippen) in die Quere, wenn beide je einen eigenen, aber schnell
// aufeinanderfolgenden Tastendruck sehen wuerden.
const helper = require('../helper');

const TAP_MAX_MS = 220;        // laenger gehalten = kein Tap mehr (analog HOLD_START_MS in holdWatcher.js)
const DOUBLE_TAP_GAP_MS = 400; // maximaler Abstand zwischen den beiden Taps
const POLL_IDLE_MS = 20;       // war 80ms - gleicher Latenz-Fix wie holdWatcher.js, s. dort
const POLL_ACTIVE_MS = 30;     // Taps sind kurz - braucht feineres Polling als Halten

let cfg = null;
let onDoubleTap = null;

let timer = null;
let downSince = 0;  // 0 = Kombination ist oben
let firstTapAt = 0; // Zeitstempel des Loslassens des ERSTEN Taps, 0 = keiner "in der Warteschlange"
let suspended = false;
let lastAccel = '';
let helperKeys = '';

function keysFor() {
  const accel = (cfg.hotkeys.flowToggle || '').trim();
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
    schedule(POLL_ACTIVE_MS);
    return;
  }

  const now = Date.now();
  if (down && !downSince) {
    downSince = now; // steigende Flanke
  } else if (!down && downSince) {
    const heldMs = now - downSince;
    downSince = 0;
    if (heldMs <= TAP_MAX_MS) {
      if (firstTapAt && now - firstTapAt <= DOUBLE_TAP_GAP_MS) {
        firstTapAt = 0;
        if (onDoubleTap) onDoubleTap();
      } else {
        firstTapAt = now;
      }
    } else {
      firstTapAt = 0; // zu lang gehalten - verwirft auch einen evtl. wartenden ersten Tap
    }
  }

  if (firstTapAt && now - firstTapAt > DOUBLE_TAP_GAP_MS) firstTapAt = 0; // wartender Tap verfaellt von selbst

  schedule(down || firstTapAt ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}

function reset() {
  downSince = 0;
  firstTapAt = 0;
}

function schedule(ms) {
  timer = setTimeout(poll, ms);
}

function start({ cfgRef, onDoubleTap: cb }) {
  cfg = cfgRef;
  onDoubleTap = cb;
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
