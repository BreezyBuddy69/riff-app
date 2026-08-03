// Riff main process — deutlich schlankeres Pendant zu Sable2s main.js
// (2098 Zeilen): kein Agent, kein Overlay, kein Circle/Summon/Act. App-
// Lifecycle, Config, Tray, die beiden Diktat-Watcher (Mode A/B) am Router —
// und seit dem App-Ausbau (APP-MASTER-PROMPT.md) die IPC-Oberflaeche fuer das
// Hauptfenster: Verlauf, Insights, Woerterbuch, Snippets, Stil, Transforms,
// Scratchpad, Konto.
const { app, ipcMain, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const config = require('./config');
const helper = require('./helper');
const autostart = require('./autostart');
const { createTray } = require('./tray');
const voiceWindow = require('./voice/window');
const appWindow = require('./appWindow');
const dictationRouter = require('./voice/dictationRouter');
const holdWatcher = require('./voice/holdWatcher');
const toggleWatcher = require('./voice/toggleWatcher');
const license = require('./license');
const store = require('./store');
const insights = require('./insights');
const account = require('./account');
const transforms = require('./transforms');
const appContext = require('./appContext');

// --hidden: stiller Autostart-Start (autostart.js haengt das beim Login-Start
// an die Verknuepfung an), zeigt kein Fenster. Jeder andere Start (Doppelklick,
// Startmenue) soll die App tatsaechlich sichtbar oeffnen.
const startHidden = process.argv.includes('--hidden');

// Vortritt-Lock (Nutzerwunsch): Riff und Sable2 forken sich dieselbe
// Diktier-Funktion (siehe DECISIONS.md D0) und teilen denselben Default-
// Hotkey "Control+Alt" - laufen beide, feuern beide gleichzeitig auf denselben
// Tastendruck. Riff soll dann Vortritt haben: dieses Lockfile (PID-Inhalt fuer
// Staleness-Check) liegt im OS-weiten Temp-Verzeichnis, ausserhalb beider
// App-eigener userData-Ordner, genau deshalb fuer beide Apps erreichbar ohne
// ein gemeinsames npm-Package. Sable2s holdWatcher.js prueft denselben Pfad
// und ignoriert seine eigene voiceFlow-Kombi, solange die hier eingetragene
// PID lebt - siehe Sable2/src/main/voice/holdWatcher.js.
const RIFF_LOCK_PATH = path.join(os.tmpdir(), 'riff-dictation.lock');

// Letzter Stand der Transform-Hotkey-Registrierung: welche Kombination hat
// Windows/eine andere App schon belegt? Die Oberflaeche zeigt das an, statt
// den Fehlschlag zu verschlucken.
let transformIssues = [];

async function toggleAutostart() {
  if (autostart.isEnabled()) { autostart.disable(); return false; }
  try {
    // hidden:true, damit ein Login-Autostart die App still im Hintergrund
    // startet (D6/Wispr-Flow-Prinzip) statt bei jedem PC-Start ein Fenster
    // aufzureissen - galt bisher nur fuer den automatischen Erststart-Fall
    // unten, nicht fuer manuelles Anschalten in den Einstellungen.
    await autostart.enable({ exePath: process.execPath, appDir: path.join(__dirname, '..', '..'), hidden: true });
    return true;
  } catch (err) {
    console.error('[riff] Autostart konnte nicht aktiviert werden:', err.message);
    return autostart.isEnabled();
  }
}

// Singleton-Lock (Sable2-Lehre, siehe Projekt-Memory): ohne das startet ein
// zweiter Doppelklick auf die Autostart-Verknuepfung eine zweite Instanz, die
// sich mit der ersten um dieselben Hotkeys und denselben Helper-Prozess
// streitet - beide wuerden auf denselben Tastendruck reagieren.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Zweiter Start (z.B. erneuter Doppelklick auf die Verknuepfung) bringt das
  // Fenster der laufenden ersten Instanz nach vorn, statt eine zweite Instanz
  // zu starten oder folgenlos zu enden.
  app.on('second-instance', () => appWindow.show());

  const cfg = config.loadConfig();

  app.whenReady().then(() => {
    app.setName('Riff');
    try { fs.writeFileSync(RIFF_LOCK_PATH, String(process.pid)); } catch {}

    voiceWindow.create();
    dictationRouter.init({ cfgRef: cfg });

    holdWatcher.start({
      cfgRef: cfg,
      onHoldStart: () => dictationRouter.startHold(),
      onHoldEnd: () => dictationRouter.endHold(),
    });
    toggleWatcher.start({
      cfgRef: cfg,
      onDoubleTap: () => dictationRouter.toggleFlow(),
    });
    transformIssues = transforms.init({ cfgRef: cfg });

    helper.warmUp();
    // TCP/TLS/Keep-Alive-Verbindung zum spaeter tatsaechlich genutzten Host
    // vorwaermen - ohne das zahlt der ALLERERSTE Diktier-Versuch der Session
    // den vollen Handshake obendrauf zur eigentlichen Transkriptions-Latenz.
    // Pfad/Antwort sind egal, das Keep-Alive-Pooling greift pro Origin.
    fetch(cfg.voice.openRouterApiKey ? 'https://openrouter.ai/api/v1/models' : 'https://n8n.halovisionai.cloud/webhook/riff-stt', {
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});

    // Konto still nachziehen (Tier/Session) - schlaegt das fehl, bleibt alles
    // wie es war. Kein Blocker fuer den Start.
    account.refresh(cfg).then(() => appWindow.send('app:account-changed')).catch(() => {});

    // Fresh install (onboardingCompleted noch false): Autostart soll von
    // Anfang an auf "ja" stehen (Nutzerwunsch), nicht erst, wenn jemand es in
    // den Einstellungen findet und selbst anschaltet. hidden:true, damit
    // spaetere Login-Starts still bleiben (D6). Nur EINMAL versucht - laueft
    // still im Hintergrund, ein Fehlschlag (seltene Rechte-Probleme) blockt
    // den Start nie.
    if (!cfg.general.onboardingCompleted && !autostart.isEnabled()) {
      autostart
        .enable({ exePath: process.execPath, appDir: path.join(__dirname, '..', '..'), hidden: true })
        .catch((err) => console.warn('[riff] Autostart-Default fehlgeschlagen:', err.message));
    }

    if (!startHidden && cfg.general.showWindowOnStartup) {
      appWindow.show();
      // Haerten gegen den bisher nicht reproduzierbaren "Tutorial kam nicht"-
      // Bug-Report (2x gemeldet): appWindow.show() ruft bereits focus()+
      // moveTop() (siehe appWindow.js), aber falls das Fenster durch einen
      // Windows-SmartScreen-Dialog o.ae. im selben Moment doch den Fokus
      // verliert/verdeckt wird, holt dieser verzoegerte zweite Versuch es
      // sicher nochmal nach vorn - billige Absicherung ohne bekannten
      // Nachteil, greift nur, wenn onboarding noch nicht durchlaufen ist.
      if (!cfg.general.onboardingCompleted) {
        setTimeout(() => { if (!cfg.general.onboardingCompleted) appWindow.show(); }, 2500);
      }
    }

    createTray({
      onQuit: () => app.quit(),
      onOpenConfig: () => shell.showItemInFolder(config.CONFIG_PATH),
      onOpenSettings: () => appWindow.show('settings'),
      getAutostartEnabled: () => autostart.isEnabled(),
      onToggleAutostart: toggleAutostart,
    });
  });

  // ---------- Zustand fuer die Oberflaeche ----------
  // Ein Aufruf liefert alles, was die 9 Views brauchen. Bei 500 Verlaufs-
  // eintraegen (store.HISTORY_LIMIT) ist das ein Payload im hohen KB-Bereich -
  // guenstiger als neun Einzelkanaele, die auseinanderlaufen koennen.
  // Bewusst NICHT enthalten: account.token (bleibt im Main-Prozess).
  function appState() {
    license.currentQuota(cfg); // rollt die Woche still weiter
    const history = store.history;
    return {
      config: {
        hotkeys: cfg.hotkeys,
        voice: cfg.voice,
        general: cfg.general,
        transforms: cfg.transforms,
      },
      autostart: autostart.isEnabled(),
      defaultHotkeys: config.DEFAULTS.hotkeys,
      weeklyLimit: license.WEEKLY_LIMIT,
      quota: cfg.quota,
      tier: cfg.account.tier,
      account: account.state(cfg),
      history,
      insights: insights.compute(history),
      dictionary: store.dictionary,
      dictSuggestions: store.suggestions(),
      snippets: store.snippets,
      transforms: store.transforms,
      styles: store.styles,
      styleLabels: appContext.STYLE_LABELS,
      categoryLabels: appContext.CATEGORY_LABELS,
      transformIssues,
    };
  }

  ipcMain.handle('app:state', () => appState());

  ipcMain.handle('settings:save', (_e, partial) => {
    const updated = config.saveConfig(partial);
    // cfg ist dieselbe Objektreferenz, die Router/Watcher als cfgRef halten -
    // in-place mutieren statt ersetzen, damit Aenderungen sofort wirken (siehe
    // Kommentar in holdWatcher.js), ohne jedem Modul ein "config geaendert"-
    // Event nachzureichen.
    Object.assign(cfg.hotkeys, updated.hotkeys);
    Object.assign(cfg.voice, updated.voice);
    Object.assign(cfg.general, updated.general);
    Object.assign(cfg.transforms, updated.transforms);
    if (partial.transforms) transformIssues = transforms.refreshShortcuts();
    if (partial.voice) dictationRouter.syncIdleBubble();
    return appState();
  });

  ipcMain.handle('license:redeem', (_e, code) => license.redeem(cfg, code));
  ipcMain.handle('settings:toggle-autostart', toggleAutostart);
  ipcMain.on('settings:open-folder', () => shell.showItemInFolder(config.CONFIG_PATH));
  // D37: waehrend der Nutzer in den Einstellungen eine neue Kombination
  // aufnimmt, muessen holdWatcher/toggleWatcher pausieren - sonst loest das
  // Druecken von z.B. "Strg+Alt" sofort ein echtes Diktat aus, statt nur als
  // neue Kombination erfasst zu werden.
  ipcMain.on('settings:suspend-hotkeys', (_e, on) => {
    holdWatcher.setSuspended(on);
    toggleWatcher.setSuspended(on);
  });
  ipcMain.on('settings:restart', () => {
    app.isQuitting = true;
    store.flush();
    app.relaunch();
    app.exit();
  });
  ipcMain.on('settings:quit', () => {
    app.isQuitting = true;
    app.quit();
  });

  // ---------- Verlauf / Listen / Stil ----------
  ipcMain.handle('history:delete', (_e, id) => { store.deleteHistory(id); return appState(); });
  ipcMain.handle('history:clear', () => { store.clearHistory(); return appState(); });
  ipcMain.handle('list:add', (_e, name, fields) => { store.listAdd(name, fields); return appState(); });
  ipcMain.handle('dict:accept-suggestion', (_e, term) => { store.acceptSuggestion(term); return appState(); });
  ipcMain.handle('dict:dismiss-suggestion', (_e, term) => { store.dismissSuggestion(term); return appState(); });
  ipcMain.handle('list:update', (_e, name, id, fields) => { store.listUpdate(name, id, fields); return appState(); });
  ipcMain.handle('list:remove', (_e, name, id) => { store.listRemove(name, id); return appState(); });
  ipcMain.handle('styles:set', (_e, partial) => { store.setStyles(partial); return appState(); });
  ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text || '')));

  // Transforms: Hotkeys neu setzen (nach Anlegen/Aendern/Loeschen) bzw. einen
  // Transform direkt auf uebergebenen Text anwenden (Verlauf/Scratchpad).
  ipcMain.handle('transforms:refresh', () => { transformIssues = transforms.refreshShortcuts(); return appState(); });
  ipcMain.handle('transforms:run', (_e, id, text) => transforms.runOnText(id, text));

  // ---------- Konto ----------
  ipcMain.handle('account:signup', (_e, creds) => account.signup(cfg, creds));
  ipcMain.handle('account:login', (_e, creds) => account.login(cfg, creds));
  ipcMain.handle('account:logout', () => account.logout(cfg));
  ipcMain.handle('account:request-reset', (_e, data) => account.requestReset(cfg, data));
  ipcMain.handle('account:confirm-reset', (_e, data) => account.confirmReset(cfg, data));

  // IPC vom Voice-Renderer (siehe renderer/voice/preload.js) - identische
  // Kommandos wie Sable2s Voice OS, nur ohne Assistent-/Hologramm-Weiterleitung.
  ipcMain.on('voice:pcm', (_e, buf) => dictationRouter.onPcmChunk(buf));
  ipcMain.on('voice:vad', (_e, evt) => dictationRouter.onVadEvent(evt));
  ipcMain.on('voice:local-error', (_e, text) => dictationRouter.onLocalError(text));
  ipcMain.on('voice:devices', (_e, list) => voiceWindow.resolveDevices(list));
  // Haken/Kreuz-Klick im Toggle-Modus (Master-Prompt §6.6) - confirm nutzt
  // denselben Pfad wie ein zweiter Doppel-Tap (dictationRouter.toggleFlow
  // entscheidet anhand des Session-Zustands, nicht der Aufrufer).
  ipcMain.on('voice:toggle-confirm', () => dictationRouter.toggleFlow());
  ipcMain.on('voice:toggle-cancel', () => dictationRouter.cancelToggle());

  // "Alle Fenster zu" darf die App nicht beenden - sie soll im Tray
  // weiterlaufen (das ist der ganze Sinn eines Hintergrund-Diktier-Tools).
  // Das Hauptfenster schliesst ohnehin nur ins Verborgene (siehe
  // appWindow.js), die Bubble bleibt eh dauerhaft bestehen.
  app.on('window-all-closed', (e) => e.preventDefault());

  app.on('before-quit', () => {
    app.isQuitting = true;
    holdWatcher.stop();
    toggleWatcher.stop();
    transforms.stop();
    helper.stop();
    store.flush(); // entprellte Schreibvorgaenge nicht verlieren
    try { fs.unlinkSync(RIFF_LOCK_PATH); } catch {}
  });
}
