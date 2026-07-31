// Reine Filterlogik gegen Whisper-Halluzinationen auf Nicht-Sprache (Stille,
// Atmen, Rauschen, Tastaturklicks) - kein Electron im Require-Baum, damit
// test/check.js sie wie dictationEngine.js pruefen kann. Ausgelagert aus
// dictationRouter.js (Nutzer-Feedback: "vielen dank" kam trotz bestehendem
// Filter noch durch).
const SILENCE_RMS = 300;

function isSilence(buf) {
  const n = buf.length >> 1;
  if (!n) return true;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n) < SILENCE_RMS;
}

// Zweite Verteidigungslinie GEGEN DIESELBE Ursache wie isSilence, aber mit
// einer anderen Schwaeche: eine globale RMS ueber den GESAMTEN Puffer kann ein
// kurzes Rauschen/Klick-Ereignis (wenige laute Samples in ansonsten stiller
// Aufnahme) durchlassen, weil der Mittelwert trotzdem unter der Schwelle
// bleibt ODER knapp drueber liegt, ohne dass irgendwo tatsaechlich gesprochen
// wurde. MIN_VOICED_MS verlangt zusaetzlich eine Mindestmenge an einzelnen
// "lauten" Samples (nicht nur einen hohen Mittelwert) - ein Wimpernschlag
// Rauschen faellt durch, ein kurzes echtes Wort (schon ab ~1-2 Silben) besteht.
// ponytail: feste Amplituden-Schwelle statt echter VAD - hochsetzen, falls
// legitime kurze Woerter faelschlich verworfen werden.
const MIN_VOICED_MS = 350;

function voicedMs(buf, sampleRate) {
  const n = buf.length >> 1;
  let loud = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(buf.readInt16LE(i * 2)) > SILENCE_RMS) loud++;
  }
  return (loud / sampleRate) * 1000;
}

// Aufnahme gilt als "nichts gesagt", wenn sie global zu leise ist ODER zu
// wenige tatsaechlich laute Samples enthaelt - beide Bedingungen muessen
// bestanden werden, damit ueberhaupt ein STT-Call (und dessen Kosten)
// ausgeloest wird.
function isSpeech(buf, sampleRate) {
  return buf.length > 0 && !isSilence(buf) && voicedMs(buf, sampleRate) >= MIN_VOICED_MS;
}

// Bekannte Whisper-Standardphrasen auf Stille/Rauschen (trainingsdatenbedingt,
// bekanntes Verhalten) - exakter Treffer (nach Normalisierung) auf das GESAMTE
// Transkript, nie ein Teiltreffer (sonst wuerde "vielen Dank fuer die Info,
// ruf mich zurueck" faelschlich unterdrueckt).
// ponytail: feste Phrasenliste statt Hallucination-Detection-Modell - neue
// Phrasen hier ergaenzen, falls sie beim Nutzer auftauchen.
const HALLUCINATION_PHRASES = new Set([
  'vielen dank', 'vielen dank für ihre aufmerksamkeit', 'vielen dank fürs zuschauen',
  'vielen vielen dank', 'vielen dank euch', 'dankeschön', 'danke schön',
  'danke fürs zuschauen', 'amen', 'untertitelung des zdf für funk',
  'untertitel der amara org-community', 'copyright wdr', 'bis zum nächsten mal',
  'tschüss', 'thank you', 'thanks for watching', 'thank you for watching', 'bye', 'you',
]);

function isHallucination(text) {
  // Apostroph-Variante ("für's") auf die Listenform ("fürs") normalisieren -
  // Whisper schreibt beide, die Liste braucht nicht jede Schreibvariante.
  const norm = text.toLowerCase().replace(/[.!?,;:]/g, '').replace(/'/g, '').replace(/\s+/g, ' ').trim();
  return HALLUCINATION_PHRASES.has(norm);
}

module.exports = { isSilence, voicedMs, isSpeech, isHallucination, SILENCE_RMS, MIN_VOICED_MS };
