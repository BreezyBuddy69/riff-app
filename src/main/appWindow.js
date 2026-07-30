// Riffs Hauptfenster. Ersetzt das frueherre 540x640-Einstellungsfenster: die
// App hat jetzt ein Zuhause (Verlauf, Insights, Woerterbuch, Snippets, Stil,
// Transforms, Konto, Einstellungen) statt nur ein Formular.
// Beim stillen Autostart (--hidden, siehe autostart.js) bleibt es unsichtbar.
const { app, BrowserWindow } = require('electron');
const path = require('path');

let win = null;

function create() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'Riff',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    backgroundColor: '#0a0a0c', // kein weisses Aufblitzen beim Oeffnen
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'app', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'app', 'index.html'));
  // Schliessen (X) versteckt nur - Riff ist ein Hintergrund-Tool (siehe
  // window-all-closed in main.js), "Beenden" geht ueber den Tray oder die
  // Einstellungen. app.isQuitting wird vor app.quit() gesetzt.
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
  return win;
}

function show(view) {
  const fresh = !win || win.isDestroyed();
  if (fresh) create();
  if (fresh) win.once('ready-to-show', () => { win.show(); if (view) send('app:navigate', view); });
  else { win.show(); if (view) send('app:navigate', view); }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Wird nach jedem Diktat gerufen: steht das Fenster offen, aktualisiert es
// Verlauf und Insights sofort - ohne Polling im Renderer.
function notifyDataChanged() {
  send('app:data-changed');
}

module.exports = { create, show, send, notifyDataChanged, getWindow: () => win };
