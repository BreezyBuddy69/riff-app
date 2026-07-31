// Reine Rechenlogik hinter dem Onboarding (onboarding.js) - kein DOM, kein
// Electron. Eigene Datei statt in onboarding.js verstreut, damit
// test/check.js (nackter Node) sie exakt wie dictationEngine.js pruefen kann.
// Laeuft in zwei Welten: als klassisches <script> im Renderer (module ist
// dort undefined, die function-Deklarationen haengen sich stattdessen ans
// globale window, siehe app.js-Kommentar) UND per require() unter Node.
const ACCEL_MODS = ['Control', 'Alt', 'Shift', 'Meta'];

function parseAccelerator(accel) {
  const parts = (accel || '').split('+').map((p) => p.trim()).filter(Boolean);
  return { mods: parts.filter((p) => ACCEL_MODS.includes(p)), mainKey: parts.find((p) => !ACCEL_MODS.includes(p)) || null };
}

function hotkeyLabel(accel) {
  const names = { Control: 'Strg', Alt: 'Alt', Shift: 'Umschalt', Meta: 'Win' };
  return (accel || '').split('+').filter(Boolean).map((p) => names[p] || p).join(' + ');
}

// Woechentliche Zeitersparnis aus zwei ECHTEN Messwerten (nie geschaetzt):
// gesprochenes vs. getipptes Tempo derselben Person, aus dem Onboarding-
// Vergleichsschritt. Ohne gueltigen Ausreisser (getippt >= gesprochen) gibt es
// ehrlich nichts zu behaupten - 0 statt einer erfundenen Zahl.
function savingsHoursPerWeek(hoursPerDay, spokenWpm, typedWpm) {
  if (!spokenWpm || !typedWpm || spokenWpm <= typedWpm || !hoursPerDay) return 0;
  const savedShare = 1 - typedWpm / spokenWpm;
  return hoursPerDay * 7 * savedShare;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseAccelerator, hotkeyLabel, savingsHoursPerWeek };
}
