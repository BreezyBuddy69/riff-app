// Autostart via .lnk im Windows-Startup-Ordner - bewusst nicht der
// Registry-Run-Key: eine Verknuepfung kann der Nutzer im Explorer einfach
// loeschen, komplett reversibel. "--autostart" laesst main.js einen stillen
// Login-Start von einem expliziten Oeffnen unterscheiden.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'create-shortcut.ps1');

function shortcutPath() {
  return path.join(
    process.env.APPDATA,
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    'Riff.lnk',
  );
}

function isEnabled() {
  return fs.existsSync(shortcutPath());
}

// hidden (Master-Prompt §6.9): "versteckt starten" haengt zusaetzlich
// --hidden an - main.js liest das beim Boot und ueberspringt dann Tray-Icon-
// Anzeige/Hauptfenster, nur die Diktat-Watcher laufen. --autostart bleibt wie
// bei Sable2 die generelle "das war ein stiller Login-Start"-Markierung.
async function enable({ exePath, appDir, hidden = false }) {
  const args = hidden ? '. --autostart --hidden' : '. --autostart';
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH,
        '-ShortcutPath', shortcutPath(),
        '-TargetPath', exePath,
        '-Arguments', args,
        '-WorkingDirectory', appDir,
        '-IconPath', path.join(appDir, 'assets', 'icon.ico'),
      ],
      { timeout: 10000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`Autostart konnte nicht eingerichtet werden: ${stderr?.trim() || err.message}`));
        else resolve();
      },
    );
  });
}

function disable() {
  const target = shortcutPath();
  if (fs.existsSync(target)) fs.unlinkSync(target);
}

module.exports = { isEnabled, enable, disable, shortcutPath };
