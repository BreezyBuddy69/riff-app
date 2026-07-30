const { contextBridge, ipcRenderer } = require('electron');

// Alles laeuft ueber IPC - die Oberflaeche selbst hat per CSP kein
// connect-src, kann also gar nicht am Main-Prozess vorbei ins Netz.
// Alle mutierenden Aufrufe geben den KOMPLETTEN neuen Zustand zurueck, damit
// der Renderer keine eigene Kopie fortschreiben muss (eine Wahrheit).
contextBridge.exposeInMainWorld('riff', {
  state: () => ipcRenderer.invoke('app:state'),
  save: (partial) => ipcRenderer.invoke('settings:save', partial),
  toggleAutostart: () => ipcRenderer.invoke('settings:toggle-autostart'),
  openConfigFolder: () => ipcRenderer.send('settings:open-folder'),
  suspendHotkeys: (on) => ipcRenderer.send('settings:suspend-hotkeys', on),
  restartApp: () => ipcRenderer.send('settings:restart'),
  quitApp: () => ipcRenderer.send('settings:quit'),
  redeemCode: (code) => ipcRenderer.invoke('license:redeem', code),

  deleteHistory: (id) => ipcRenderer.invoke('history:delete', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  listAdd: (name, fields) => ipcRenderer.invoke('list:add', name, fields),
  listUpdate: (name, id, fields) => ipcRenderer.invoke('list:update', name, id, fields),
  listRemove: (name, id) => ipcRenderer.invoke('list:remove', name, id),
  acceptDictSuggestion: (term) => ipcRenderer.invoke('dict:accept-suggestion', term),
  dismissDictSuggestion: (term) => ipcRenderer.invoke('dict:dismiss-suggestion', term),
  setStyles: (partial) => ipcRenderer.invoke('styles:set', partial),
  copy: (text) => ipcRenderer.send('clipboard:write', text),

  refreshTransforms: () => ipcRenderer.invoke('transforms:refresh'),
  runTransform: (id, text) => ipcRenderer.invoke('transforms:run', id, text),

  signup: (creds) => ipcRenderer.invoke('account:signup', creds),
  login: (creds) => ipcRenderer.invoke('account:login', creds),
  logout: () => ipcRenderer.invoke('account:logout'),
  requestReset: (data) => ipcRenderer.invoke('account:request-reset', data),
  confirmReset: (data) => ipcRenderer.invoke('account:confirm-reset', data),

  onDataChanged: (fn) => ipcRenderer.on('app:data-changed', () => fn()),
  onAccountChanged: (fn) => ipcRenderer.on('app:account-changed', () => fn()),
  onNavigate: (fn) => ipcRenderer.on('app:navigate', (_e, view) => fn(view)),
});
