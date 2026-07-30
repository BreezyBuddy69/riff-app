// Tray-Menue: deutlich schlanker als Sable2s (kein Routing-Modus, kein
// Circle/Summon, kein Sprachassistent-Umschalter) - Riff hat nur einen Job,
// das Menue macht ihn sichtbar plus die noetigsten Verwaltungspunkte.
const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

function createTray({ onQuit, onOpenConfig, onOpenSettings, getAutostartEnabled, onToggleAutostart }) {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Riff — Diktat läuft im Hintergrund');

  function rebuildMenu() {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Riff öffnen…', click: onOpenSettings },
      { type: 'separator' },
      {
        label: 'Mit Windows starten',
        type: 'checkbox',
        checked: getAutostartEnabled(),
        // await noetig: onToggleAutostart() ist async (PowerShell-Skript fuer
        // die .lnk) - rebuildMenu() VOR dem Abschluss wuerde die Checkbox mit
        // dem alten Zustand neu zeichnen, ein Klick sich also "wirkungslos".
        click: async () => { await onToggleAutostart(); rebuildMenu(); },
      },
      { label: 'Konfiguration öffnen…', click: onOpenConfig },
      { type: 'separator' },
      { label: 'Beenden', click: onQuit },
    ]));
  }

  rebuildMenu();
  // Doppelklick auf das Tray-Icon oeffnet das Fenster (Windows-Konvention
  // fuer Hintergrund-Apps, z.B. Wispr Flow).
  tray.on('double-click', onOpenSettings);
  return { tray, rebuildMenu };
}

module.exports = { createTray };
