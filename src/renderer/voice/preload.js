const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voice', {
  sendPcm: (buf) => ipcRenderer.send('voice:pcm', buf),
  sendVad: (evt) => ipcRenderer.send('voice:vad', evt),
  sendDevices: (list) => ipcRenderer.send('voice:devices', list),
  // Renderer-lokale Fehler (getUserMedia) - main muss das Fenster auf die
  // Fehlergroesse bringen, der Renderer kann das selbst nicht.
  sendLocalError: (text) => ipcRenderer.send('voice:local-error', text),
  // Haken/Kreuz-Klick im Toggle-Modus (Master-Prompt §6.6) - main entscheidet,
  // was "bestaetigen"/"verwerfen" konkret bedeutet.
  confirmToggle: () => ipcRenderer.send('voice:toggle-confirm'),
  cancelToggle: () => ipcRenderer.send('voice:toggle-cancel'),
  onCommand: (cb) => ipcRenderer.on('voice:command', (_e, cmd) => cb(cmd)),
  onUiState: (cb) => ipcRenderer.on('voice:ui-state', (_e, state) => cb(state)),
});
