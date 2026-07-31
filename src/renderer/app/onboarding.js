// Erststart-Tutorial (Wispr-Flow-Vorbild): Mikro-/Shortcut-Test, eine echte
// Diktier-Demo (laeuft ueber die tatsaechliche Pipeline - Bubble, STT,
// Cleanup, Paste, siehe dictationRouter.js), Sprech- vs. Tipptempo-Vergleich
// aus ECHTEN Messwerten, Zeitersparnis-Hochrechnung, optionales Konto.
// Laeuft als Overlay VOR der normalen Shell, solange
// cfg.general.onboardingCompleted false ist (siehe config.js).
//
// Nutzt bewusst dieselben globalen Bindungen wie app.js ($, node, toast,
// reload, go, S) statt eigener Kopien - beide Dateien sind klassische
// Scripts im selben Dokument, kein Modul-System noetig fuer eine einzige
// gemeinsam genutzte Handvoll Helfer.

const OB_STEPS = ['welcome', 'mic', 'shortcut', 'demo', 'compare', 'savings', 'finish'];
let obStep = 0;
let obActive = false;

let obMicStream = null;
let obMicCtx = null;
let obMicRaf = 0;

let obShortcutMods = [];
let obShortcutMainKey = null;
let obShortcutHeld = new Set();
let obShortcutDetected = false;

let obDataChangedGuard = false; // verhindert doppeltes Erfassen, falls app:data-changed mehrfach feuert
let obSpokenWpm = null;
let obSpokenText = '';
let obTypedWpm = null;
let obTypeStart = 0;

// parseAccelerator/hotkeyLabel/savingsHoursPerWeek kommen aus
// onboardingLogic.js (vor dieser Datei geladen, siehe index.html) - reine
// Funktionen, dort auch von test/check.js geprueft.

function obRenderProgress() {
  const wrap = $('obProgress');
  wrap.replaceChildren(...OB_STEPS.map((_, i) => node('i', {
    class: i < obStep ? 'done' : i === obStep ? 'active' : '',
  })));
}

function obShowStep(name) {
  for (const el of document.querySelectorAll('.ob-step')) el.hidden = el.dataset.step !== name;
  obRenderProgress();
}

function obStopMic() {
  if (obMicRaf) cancelAnimationFrame(obMicRaf);
  obMicRaf = 0;
  if (obMicStream) { for (const t of obMicStream.getTracks()) t.stop(); obMicStream = null; }
  if (obMicCtx && obMicCtx.state !== 'closed') obMicCtx.close().catch(() => {});
  obMicCtx = null;
}

async function obStartMic(deviceId) {
  obStopMic();
  $('obMicHint').textContent = 'Warte auf Mikrofon-Freigabe …';
  try {
    obMicStream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId } : true });
  } catch {
    $('obMicHint').textContent = 'Mikrofon nicht verfügbar oder Zugriff abgelehnt.';
    return;
  }
  $('obMicHint').textContent = 'Sag ein paar Worte.';
  obMicCtx = new AudioContext();
  const src = obMicCtx.createMediaStreamSource(obMicStream);
  const analyser = obMicCtx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const bars = Array.from(document.querySelectorAll('#obLevels i'));
  const loop = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    const level = Math.min(1, Math.sqrt(sum / data.length) * 6);
    bars.forEach((bar, i) => {
      const jitter = 0.6 + 0.4 * Math.sin(i * 1.7);
      bar.style.transform = `scaleY(${Math.max(0.06, level * jitter)})`;
    });
    obMicRaf = requestAnimationFrame(loop);
  };
  loop();
}

async function obPopulateMicDevices() {
  const select = $('obMicDevice');
  try {
    // Labels sind erst nach einer erteilten Berechtigung vollstaendig - der
    // erste getUserMedia-Aufruf in obStartMic() holt genau die ein.
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    select.replaceChildren(
      node('option', { value: '' }, 'Standardmikrofon'),
      ...inputs.map((d, i) => node('option', { value: d.deviceId }, d.label || `Mikrofon ${i + 1}`)),
    );
    select.value = (S.config.voice.audioDeviceId) || '';
  } catch { /* Geraeteliste ist rein kosmetisch - kein harter Fehler */ }
}

function obEnterMic() {
  const bars = Array.from({ length: 10 }, () => node('i'));
  $('obLevels').replaceChildren(...bars);
  obStartMic(S.config.voice.audioDeviceId || undefined).then(() => obPopulateMicDevices());
}

$('obMicDevice').addEventListener('change', async (e) => {
  const deviceId = e.target.value;
  await window.riff.save({ voice: { audioDeviceId: deviceId } });
  obStartMic(deviceId || undefined);
});

// ---------- Shortcut-Test ----------

function obRenderKeys() {
  const { mods, mainKey } = parseAccelerator(S.config.hotkeys.flowHold);
  obShortcutMods = mods;
  obShortcutMainKey = mainKey;
  const names = { Control: 'Strg', Alt: 'Alt', Shift: 'Umschalt', Meta: 'Win' };
  $('obKeys').replaceChildren(...[...mods, mainKey].filter(Boolean).map((k) => node('kbd', { text: names[k] || k })));
}

function obMainKeyMatches(e, mainKey) {
  if (!mainKey) return false;
  if (/^[A-Z0-9]$/.test(mainKey)) return e.key.toUpperCase() === mainKey || e.code === `Key${mainKey}` || e.code === `Digit${mainKey}`;
  return e.key.toLowerCase() === mainKey.toLowerCase();
}

function obShortcutIsHeld(e) {
  const modsOk = obShortcutMods.every((m) => (
    m === 'Control' ? e.ctrlKey : m === 'Alt' ? e.altKey : m === 'Shift' ? e.shiftKey : e.metaKey
  ));
  return modsOk && (!obShortcutMainKey || obShortcutHeld.has('main'));
}

function obShortcutKeydown(e) {
  if (obMainKeyMatches(e, obShortcutMainKey)) obShortcutHeld.add('main');
  if (!obShortcutDetected && obShortcutIsHeld(e)) {
    obShortcutDetected = true;
    for (const kbd of document.querySelectorAll('#obKeys kbd')) kbd.classList.add('active');
    const hint = $('obShortcutHint');
    hint.textContent = 'Erkannt! ✓';
    hint.classList.add('ok');
    $('obShortcutNext').disabled = false;
  }
}

function obShortcutKeyup(e) {
  if (obMainKeyMatches(e, obShortcutMainKey)) obShortcutHeld.delete('main');
  if (!obShortcutIsHeld(e)) for (const kbd of document.querySelectorAll('#obKeys kbd')) kbd.classList.remove('active');
}

function obEnterShortcut() {
  obShortcutDetected = false;
  obShortcutHeld.clear();
  $('obShortcutNext').disabled = true;
  const hint = $('obShortcutHint');
  hint.textContent = 'Noch nicht erkannt.';
  hint.classList.remove('ok');
  obRenderKeys();
}

// ---------- Live-Demo ----------

function obEnterDemo() {
  obDataChangedGuard = false;
  $('obDemoNext').disabled = true;
  $('obDemoHint').textContent = 'Wartet auf dein erstes Diktat …';
  const field = $('obDemoField');
  field.value = '';
  field.focus();
}

function obOnDataChanged() {
  if (obStep !== OB_STEPS.indexOf('demo') || obDataChangedGuard) return;
  window.riff.state().then((state) => {
    const h = state.history[0];
    if (!h) return;
    obDataChangedGuard = true;
    obSpokenText = h.text || '';
    obSpokenWpm = (h.durationMs >= 1500 && h.words) ? Math.round(h.words / (h.durationMs / 60000)) : null;
    $('obDemoHint').textContent = 'Hat geklappt! ✓';
    $('obDemoHint').classList.add('ok');
    $('obDemoNext').disabled = false;
  });
}

// ---------- Sprech- vs. Tipptempo ----------

function obEnterCompare() {
  $('obCompareTarget').textContent = obSpokenText ? `„${obSpokenText}“` : 'Tipp einen kurzen Satz.';
  $('obCompareField').value = '';
  $('obCompareResult').hidden = true;
  $('obCompareNext').disabled = true;
  $('obCompareHint').textContent = 'Der Timer startet mit deinem ersten Tastendruck.';
  obTypeStart = 0;
  obTypedWpm = null;
}

$('obCompareField').addEventListener('input', (e) => {
  if (!obTypeStart) obTypeStart = performance.now();
  const typed = e.target.value.trim();
  const target = obSpokenText.trim();
  const done = target ? typed.length >= target.length : typed.split(/\s+/).filter(Boolean).length >= 3;
  if (!done) return;
  const elapsedMin = Math.max(0.05, (performance.now() - obTypeStart) / 60000);
  const words = typed.split(/\s+/).filter(Boolean).length;
  obTypedWpm = Math.round(words / elapsedMin);
  $('obSpokenWpm').textContent = obSpokenWpm || '–';
  $('obTypedWpm').textContent = obTypedWpm;
  $('obCompareResult').hidden = false;
  $('obCompareHint').textContent = 'Fertig!';
  $('obCompareNext').disabled = false;
});

// ---------- Zeitersparnis ----------

function obComputeSavings() {
  const hours = Number($('obHoursSlider').value);
  $('obHoursValue').textContent = hours;
  const hoursPerWeek = savingsHoursPerWeek(hours, obSpokenWpm, obTypedWpm);
  $('obSavingsHeadline').textContent = hoursPerWeek > 0
    ? `Mit Riff sparst du ~${hoursPerWeek.toFixed(1)} Stunden pro Woche!`
    : 'Diktiere öfter, dann rechnen wir es dir aus.';
}

$('obHoursSlider').addEventListener('input', obComputeSavings);

// ---------- Fertig / Konto ----------

function obEnterFinish() {
  $('obSignupError').hidden = true;
}

$('obSignupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('obSignupEmail').value.trim();
  const password = $('obSignupPassword').value;
  const name = $('obSignupName').value.trim();
  const err = $('obSignupError');
  if (!email || !password) {
    err.hidden = false;
    err.textContent = 'E-Mail und Passwort ausfüllen — oder unten ohne Konto starten.';
    return;
  }
  const res = await window.riff.signup({ email, password, name });
  if (!res.ok) {
    err.hidden = false;
    err.textContent = (res.reply || '').split(' / ')[0] || 'Registrierung fehlgeschlagen.';
    return;
  }
  err.hidden = true;
  toast(`Konto erstellt — willkommen, ${name || email}.`);
});

async function obFinish() {
  obStopMic();
  await window.riff.save({ general: { onboardingCompleted: true } });
  obActive = false;
  $('onboarding').hidden = true;
  await reload();
  go('dictation');
}

$('obFinishBtn').addEventListener('click', obFinish);

// ---------- Navigation ----------

const OB_ENTER = { mic: obEnterMic, shortcut: obEnterShortcut, demo: obEnterDemo, compare: obEnterCompare, savings: obComputeSavings, finish: obEnterFinish };
const OB_LEAVE = { mic: obStopMic };

function obGoto(index) {
  const leaving = OB_STEPS[obStep];
  OB_LEAVE[leaving]?.();
  obStep = Math.max(0, Math.min(OB_STEPS.length - 1, index));
  const name = OB_STEPS[obStep];
  obShowStep(name);
  for (const el of document.querySelectorAll('.ob-hotkey-label')) el.textContent = hotkeyLabel(S.config.hotkeys.flowHold);
  OB_ENTER[name]?.();
}

document.addEventListener('click', (e) => {
  if (!obActive) return;
  if (e.target.closest('.ob-next, .ob-skip')) obGoto(obStep + 1);
});

window.addEventListener('keydown', (e) => { if (obActive && OB_STEPS[obStep] === 'shortcut') obShortcutKeydown(e); });
window.addEventListener('keyup', (e) => { if (obActive && OB_STEPS[obStep] === 'shortcut') obShortcutKeyup(e); });
window.riff.onDataChanged(obOnDataChanged);

function startOnboarding() {
  obActive = true;
  obStep = 0;
  $('onboarding').hidden = false;
  obGoto(0);
}

function maybeStartOnboarding(state) {
  if (!state.config.general.onboardingCompleted) startOnboarding();
}

$('replayOnboarding').addEventListener('click', () => { go('dictation'); startOnboarding(); });
