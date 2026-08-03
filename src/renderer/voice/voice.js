// Voice-Renderer: eigenes, immer lebendiges Fenster (siehe window.js).
// Kapselt die komplette Web-Audio-Arbeit - main.js schickt nur Kommandos und
// UI-State, hier passiert Mic-Zugriff, Worklet und IPC-Weiterreichung.
// Getrimmt aus Sable2s voice.js (websites/riff-MASTER-PROMPT.md §5): keine
// TTS-Wiedergabe/Echo-Guard-Logik mehr, Riff spricht nie zurueck.

const pill = document.getElementById('pill');
const errorText = document.getElementById('errorText');
const bars = Array.from(document.querySelectorAll('#bars .bar'));
const confirmBtn = document.getElementById('confirmBtn');
const cancelBtn = document.getElementById('cancelBtn');

// Tonband-Prinzip (Nutzerwunsch): jeder Balken ist ein Pegel-Sample aus der
// juengeren Vergangenheit statt einer kuenstlich gespiegelten Gewichtskurve
// um einen einzelnen Momentanwert. Index 0 = aeltestes Sample (linker
// Balken), letzter Index = neuestes (rechter Balken) - neue Pegel kommen
// rechts rein und ruecken bei jedem Update eins nach links durch, wie Band
// durch einen Tonkopf laeuft.
let levelHistory = new Array(bars.length).fill(0);

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let workletNode = null;

// ---------- UI-State vom Main-Prozess ----------
function applyUiState(state) {
  if (!state) return;
  pill.setAttribute('data-phase', state.phase || 'idle');
  pill.setAttribute('data-kind', state.kind || 'hold');
  errorText.textContent = state.phase === 'error' ? (state.errorText || 'Fehler') : '';
  if (state.phase !== 'listening') resetLevels();
}

function showLocalError(text) {
  window.voice.sendLocalError(text);
}

// ---------- Level-Balken (Waveform) ----------
function renderLevels() {
  bars.forEach((bar, i) => {
    bar.style.transform = `scaleY(${Math.max(0.12, levelHistory[i])})`;
  });
}

function pushLevel(level) {
  levelHistory.shift();
  levelHistory.push(Math.max(0, Math.min(1, level * 4)));
  renderLevels();
}

function resetLevels() {
  levelHistory.fill(0);
  renderLevels();
}

// ---------- Kommandos vom Main-Prozess ----------
async function handleCommand(cmd) {
  if (!cmd || !cmd.type) return;
  switch (cmd.type) {
    case 'list-devices':
      await listDevices();
      break;
    case 'start-capture':
      await startCapture(cmd);
      break;
    case 'stop-capture':
      await stopCapture();
      break;
    case 'play-cue':
      playCue(cmd.cue, cmd.volume);
      break;
  }
}

// Kurzer synthetischer Ton statt einer Audio-Datei (Nutzer-Feedback: hoerbar
// merken, ob Riff gerade zuhoert, ohne auf die Bubble zu schauen) - eigener,
// kurzlebiger AudioContext statt des Capture-Contexts oben, damit ein
// Ton-Wiedergabefehler die Aufnahme selbst nie beruehrt.
function playCue(kind, volume) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = kind === 'end' ? 480 : 720;
    const peak = Math.max(0, Math.min(1, volume ?? 0.6)) * 0.2;
    const now = ctx.currentTime;
    // Weiche Huelle statt hartem An/Aus (Nutzerwunsch: "schoenerer, softerer
    // Sound") - vorher sprang die Lautstaerke ohne Envelope sofort auf den
    // vollen Wert, das erzeugt ein hoerbares Klicken am Einsatz. Schneller
    // Attack, exponentieller Decay klingt runder als ein hartes Gate.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.24);
    osc.onended = () => ctx.close().catch(() => {});
  } catch { /* rein kosmetisch - darf die Diktier-Pipeline nie stoeren */ }
}

async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    window.voice.sendDevices(inputs);
  } catch {
    window.voice.sendDevices([]);
  }
}

async function startCapture(cmd) {
  await stopCapture(); // idempotent - falls schon etwas laeuft, sauber neu starten

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: cmd.deviceId || undefined,
        noiseSuppression: !!cmd.noiseSuppression,
        echoCancellation: true,
        autoGainControl: true,
      },
    });

    audioContext = new AudioContext({ sampleRate: cmd.sampleRate || 16000 });
    await audioContext.audioWorklet.addModule('pcm-worklet.js');

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, 'pcm-processor', { processorOptions: {} });

    workletNode.port.onmessage = (event) => {
      const { pcm, level, vadEvent } = event.data;
      if (pcm && pcm.byteLength) window.voice.sendPcm(pcm);
      if (vadEvent) window.voice.sendVad({ state: vadEvent, level });
      pushLevel(level);
    };

    // Bewusst NICHT an audioContext.destination haengen - sonst hoert sich
    // der Nutzer live selbst ueber die Lautsprecher (Feedback/Echo).
    sourceNode.connect(workletNode);
  } catch (err) {
    await stopCapture();
    showLocalError('Mikrofon nicht verfügbar');
  }
}

async function stopCapture() {
  try {
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) track.stop();
    }
    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    }
    if (sourceNode) sourceNode.disconnect();
    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close();
    }
  } catch {
    // Teardown darf den Renderer nie crashen - wird auch aufgerufen, wenn
    // gerade gar nichts laeuft (Idempotenz ist hier der Sinn des try/catch).
  } finally {
    mediaStream = null;
    sourceNode = null;
    workletNode = null;
    audioContext = null;
    resetLevels();
  }
}

// Haken/Kreuz sind nur im Toggle-Modus sichtbar/klickbar (voice.css:
// [data-kind="toggle"][data-phase="listening"]) - window.js macht das
// Fenster fuer genau dieses Zeitfenster interaktiv (setInteractive).
confirmBtn.addEventListener('click', () => window.voice.confirmToggle());
cancelBtn.addEventListener('click', () => window.voice.cancelToggle());

// Ruhezustand (voice.idleBubbleEnabled): ein Klick auf den kleinen Punkt
// startet ein Diktat - dieselbe IPC wie der Haken-Klick im Toggle-Modus,
// dictationRouter.toggleFlow() startet eine neue Session, wenn keine laeuft.
pill.addEventListener('click', () => {
  if (pill.getAttribute('data-phase') === 'resting') window.voice.confirmToggle();
});

window.voice.onCommand(handleCommand);
window.voice.onUiState(applyUiState);
