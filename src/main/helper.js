// Manager fuer den persistenten PowerShell-Helper (helper/RiffHelper.ps1,
// Fork von Sable2s SableHelper.ps1 - siehe websites/riff-MASTER-PROMPT.md §5).
// Ein Prozess fuer die Lebensdauer der App, JSON-Lines ueber stdin/stdout -
// Aktions-Roundtrips bleiben so unter dem 300ms-Budget statt pro Aktion
// einen PowerShell-Kaltstart (~600-1500ms) zu bezahlen. Stirbt der Prozess,
// startet der naechste Aufruf ihn transparent neu.
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const HELPER_PATH = path.join(__dirname, '..', '..', 'helper', 'RiffHelper.ps1');
// macOS-Gegenstueck (helper/RiffHelperMac.swift, UNGETESTET - siehe Kommentar
// dort) - wird von scripts/build-mac-helper.sh auf dem GitHub-Actions-macOS-
// Runner zu einer fertigen Mach-O-Datei kompiliert, BEVOR electron-builder
// laeuft. `files: ["helper/**/*"]` in package.json nimmt sie automatisch mit,
// kein extraResources noetig - gleiches Prinzip wie HELPER_PATH oben (asar:
// false, __dirname-relative Pfade sind in Dev UND gepackt identisch).
const HELPER_PATH_MAC = path.join(__dirname, '..', '..', 'helper', 'RiffHelperMac');
const REQUEST_TIMEOUT_MS = 15000;

let child = null;
let readyPromise = null;
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, timer}

function cleanup(reason) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
  child = null;
  readyPromise = null;
}

function ensureStarted() {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    // Werte gehen ausschliesslich als JSON ueber stdin an ein festes Skript -
    // hier wird nie Modell-Output in eine Befehlszeile interpoliert.
    // Plattform-Weiche: identisches JSON-Lines-Protokoll auf beiden Seiten
    // (siehe Kommentar-Kopf in RiffHelper.ps1 bzw. RiffHelperMac.swift) - der
    // Rest dieser Datei (request/ensureStarted/warmUp) ist bewusst NICHT
    // plattformabhaengig, nur der Spawn selbst.
    child = process.platform === 'darwin'
      ? spawn(HELPER_PATH_MAC, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH,
      ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    const startTimer = setTimeout(() => {
      reject(new Error('Action-Helper nicht rechtzeitig bereit'));
      try { child.kill(); } catch { /* schon tot */ }
    }, 20000);

    // Explizit setzen statt dem Default zu vertrauen - sonst koennen
    // mehrbytige UTF-8-Zeichen (Umlaute, „typografische" Anfuehrungszeichen)
    // in Fehlermeldungen aus dem Helper kaputtgehen, wenn ein Chunk mitten in
    // einer Byte-Sequenz endet.
    child.stdout.setEncoding('utf8');
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // fremde Ausgabezeile ignorieren
      }
      if (msg.ready) {
        clearTimeout(startTimer);
        resolve();
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) {
        entry.resolve(msg.result || {});
      } else {
        // msg.code kommt aus RiffHelper.ps1s $script:lastErrorCode (an der
        // Fehlerquelle gesetzt, z.B. ELEMENT_NOT_FOUND/WINDOW_NOT_FOUND) -
        // strukturiert statt Regex auf die deutsche Fehlermeldung (main.js
        // attemptRepair() kann so gezielter reagieren, siehe D19).
        const err = new Error(msg.error || 'Helper-Fehler');
        if (msg.code) err.code = msg.code;
        entry.reject(err);
      }
    });

    child.stderr.on('data', (d) => console.error('[helper]', String(d).trim()));
    child.on('exit', (code) => {
      console.warn(`[helper] Prozess beendet (Code ${code})`);
      cleanup(`Action-Helper beendet (Code ${code})`);
    });
    child.on('error', (err) => {
      clearTimeout(startTimer);
      cleanup(err.message);
      reject(err);
    });
  });
  return readyPromise;
}

async function request(op, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  await ensureStarted();
  const id = nextId++;
  const payload = `${JSON.stringify({ id, op, ...params })}\n`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const err = new Error(`Aktion "${op}" hat nicht rechtzeitig geantwortet`);
      err.code = 'HELPER_TIMEOUT';
      reject(err);
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(payload, (err) => {
      if (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

// Beim App-Start einmal anwerfen, damit der erste echte Aktionswunsch nicht
// die Ladezeit der .NET-Assemblies bezahlt.
function warmUp() {
  request('ping', {}, 25000).then(
    () => console.log('[helper] bereit'),
    (err) => console.warn('[helper] Warm-up fehlgeschlagen:', err.message),
  );
}

function stop() {
  if (child) {
    try { child.stdin.end(); child.kill(); } catch { /* egal */ }
  }
}

module.exports = { request, warmUp, stop };
