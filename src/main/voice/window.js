// Riff-Bubble: schwebendes, NICHT fokussierbares Indicator-Fenster (Mic-Pille),
// aus Sable2s Voice-OS-Fenster geforkt (siehe websites/riff-MASTER-PROMPT.md §5).
// Wird beim App-Start VORAB erzeugt (kein Ladezeit-Overhead beim ersten
// Hotkey-Druck) und bleibt die gesamte App-Laufzeit ueber bestehen - es haelt
// im Renderer auch den Mikrofon-Stream, wird nur ein-/ausgeblendet statt neu
// erzeugt. focusable:false ist strukturell wichtig: Diktat tippt in eine
// ANDERE App, der OS-Fokus darf diesem Fenster nie folgen (sonst tippt die
// Diktier-Ausgabe ins eigene UI statt ins Zielfenster).
const { BrowserWindow, screen, session } = require('electron');
const path = require('path');

// Kleiner als Sable2s Pille (Master-Prompt §6.6: "kleiner und cleaner").
// Drei feste Groessen statt stufenlosem Resize (gleiches Prinzip wie Sable2
// D2: feste Fenstergroesse pro Zustand, kein Ruckeln) - MUSS mit den
// #pill-Breiten in voice.css synchron bleiben:
//   normal - Ruhezustand/Hold-Modus, nur die Waveform.
//   toggle - Toggle-Modus WAEHREND der Aufnahme: zusaetzlich Platz fuer die
//            winzigen Haken/Kreuz-Icons zum Bestaetigen/Verwerfen per Maus.
//   error  - Fehlertexte sind laenger als jeder Status und passen nicht
//            einzeilig in die schmale Pille - eigene, groessere Flaeche statt
//            den Text mit "…" abzuschneiden.
const SIZES = {
  normal: { w: 96, h: 40 },
  toggle: { w: 118, h: 40 },
  error: { w: 320, h: 120 },
};

let win = null;
let pendingDevices = null;

function computeBounds(sizeKey = 'normal') {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const work = display.workArea;
  const { w, h } = SIZES[sizeKey] || SIZES.normal;
  // Unten MITTIG (wie Wispr Flow), nicht mehr unten rechts. Mit sichtbarer
  // Taskbar endet workArea ueber ihr -> 16px Abstand darueber. Ohne Taskbar
  // (workArea = volle Displayhoehe, z.B. Auto-Hide) darf die Pille bewusst
  // etwas tiefer an die Bildschirmkante rutschen.
  const hasTaskbar = work.height < display.bounds.height || work.y > display.bounds.y;
  const gap = hasTaskbar ? 16 : 8;
  return {
    x: Math.round(work.x + (work.width - w) / 2),
    y: Math.round(work.y + work.height - h - gap),
    width: w,
    height: h,
  };
}

function create() {
  win = new BrowserWindow({
    ...computeBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'renderer', 'voice', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Muss auch VERSTECKT reagieren (list-devices-Anfragen, Statuswechsel) -
      // wie das Overlay (D2) bewusst nicht gedrosselt.
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(process.env.RIFF_ALLOW_CAPTURE !== '1');
  // Reine Anzeige, keine Klickflaeche noetig - Maus geht "durch". Toggle-Modus
  // (Haken/Kreuz-Buttons) schaltet das kurz per setInteractive(true) um.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'voice', 'voice.html'));
  win.on('closed', () => { win = null; });

  // Master-Prompt §6.6: Bubble folgt der Taskbar, wenn diese verschoben/
  // versteckt wird. display-metrics-changed feuert bei Work-Area-Aenderungen
  // zuverlaessig - kein Polling noetig. Nur neu positionieren, wenn die Pille
  // gerade sichtbar ist (sonst wuerde ein verstecktes Fenster sichtbar an der
  // falschen alten Position aufblitzen, wenn es das naechste Mal show()
  // bekommt - das berechnet ohnehin computeBounds() bei jedem show() frisch).
  // Muss INNERHALB create() registriert werden, nicht beim Modul-Laden: das
  // screen-Modul wirft vor dem 'ready'-Event, und create() laeuft erst nach
  // app.whenReady() (siehe main.js).
  screen.on('display-metrics-changed', () => {
    if (win && !win.isDestroyed() && win.isVisible()) win.setBounds(computeBounds());
  });

  return win;
}

// Mikrofon-Berechtigung ausschliesslich fuer dieses eine Fenster - D15/D8-
// Prinzip: nichts implizit erlauben, jede andere WebContents-Anfrage (auch
// zukuenftige) faellt sonst unter denselben globalen Handler.
function allowMicPermission() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' && !!win && !win.isDestroyed() && wc.id === win.webContents.id);
  });
}

function show(opts = {}) {
  if (!win || win.isDestroyed()) create();
  win.setBounds(computeBounds(opts.size));
  win.showInactive(); // sichtbar, aber NIE fokussiert - Ziel-App behaelt den OS-Fokus
  // Vortritt vor Sable2/Mumats eigener Bubble (Nutzerwunsch): beide laufen auf
  // demselben 'screen-saver'-alwaysOnTop-Level, das OS entscheidet bei Gleichstand
  // nach zuletzt-angefasst - moveTop() zwingt Riffs Pille JEDES Mal beim Anzeigen
  // wieder ganz nach oben, unabhaengig davon, was Sable2/Mumat zuletzt gemacht hat.
  win.moveTop();
}

// Groesse nachtraeglich wechseln, waehrend die Pille schon sichtbar ist (z.B.
// Uebergang listening -> error, oder toggle-Aufnahme startet/endet) - bleibt
// an der gleichen Bildschirmecke verankert, computeBounds() rechnet x/y bei
// jeder Groesse neu von unten Mitte aus.
function resize(sizeKey) {
  if (win && !win.isDestroyed()) win.setBounds(computeBounds(sizeKey));
}

function hide() {
  if (win && !win.isDestroyed()) win.hide();
}

// Toggle-Modus (Mode B) zeigt zwei winzige Haken/Kreuz-Icons zum Bestaetigen/
// Verwerfen per Maus (Master-Prompt §6.6) - dafuer muss die Pille kurz
// klickbar werden, statt wie sonst komplett click-through zu sein. Hold-Modus
// (Mode A) ruft das nie auf, bleibt immer click-through.
function setInteractive(on) {
  if (!win || win.isDestroyed()) return;
  if (on) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Geraeteliste kommt nur aus dem Renderer (navigator.mediaDevices) - kein
// echtes Request/Response-IPC dafuer, also ein simpler Promise-Korrelator:
// Kommando raus, naechste 'voice:devices'-Antwort loest auf (mit Timeout,
// falls das Fenster (noch) nicht geladen/bereit ist).
function listAudioDevices() {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) { resolve([]); return; }
    pendingDevices = resolve;
    win.webContents.send('voice:command', { type: 'list-devices' });
    setTimeout(() => {
      if (pendingDevices) { pendingDevices([]); pendingDevices = null; }
    }, 3000);
  });
}

function resolveDevices(list) {
  if (pendingDevices) { pendingDevices(Array.isArray(list) ? list : []); pendingDevices = null; }
}

module.exports = {
  create, show, hide, resize, send, setInteractive, allowMicPermission, listAudioDevices, resolveDevices,
  getWindow: () => win,
};
