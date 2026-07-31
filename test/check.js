// Selbstpruefung der rechnenden Logik hinter Insights/Verlauf: `node test/check.js`.
// Kein Framework, keine Fixtures - genau die Faelle, die stillschweigend falsche
// Zahlen in die Oberflaeche schreiben wuerden, wenn sie brechen.
// Bewusst NUR pure Module (insights, dictationEngine): alles mit `electron`
// im require-Baum laeuft nicht unter nacktem Node.
const assert = require('node:assert/strict');

const insights = require('../src/main/insights');
const { resolveDictation, applySnippets } = require('../src/main/voice/dictationEngine');
const { categorize, cleanupExtras } = require('../src/main/appContext');
const { parseAccelerator, hotkeyLabel, savingsHoursPerWeek } = require('../src/renderer/app/onboardingLogic');
const { isSilence, isSpeech, isHallucination } = require('../src/main/voice/silenceFilter');

function pcm(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

function isoDaysAgo(days, hour = 12) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

const entry = (over = {}) => ({
  ts: isoDaysAgo(0), app: 'notepad', appCategory: 'other', mode: 'hold',
  raw: '', text: '', words: 20, durationMs: 10000, fixes: 0, dictFixes: 0, ...over,
});

// --- WPM: Median, nicht Mittelwert -------------------------------------------
// 20 Woerter in 10s = 120 WPM. Der Ausreisser (3 Woerter in 0,4s = 450 WPM)
// muss rausfallen, sonst behauptet die App eine Geschwindigkeit, die nie
// jemand gesprochen hat.
{
  const h = [
    entry({ words: 20, durationMs: 10000 }),
    entry({ words: 20, durationMs: 10000 }),
    entry({ words: 3, durationMs: 400 }),
  ];
  assert.equal(insights.compute(h).wpm, 120, 'WPM muss den Kurz-Ausreisser ignorieren');
  assert.equal(insights.compute([]).wpm, 0, 'ohne Daten kein WPM');
}

// --- Serie: heute darf noch fehlen, gestern haelt die Serie ------------------
{
  const gapless = insights.compute([entry({ ts: isoDaysAgo(1) }), entry({ ts: isoDaysAgo(2) })]);
  assert.equal(gapless.streak, 2, 'gestern+vorgestern = laufende Serie von 2');

  const broken = insights.compute([entry({ ts: isoDaysAgo(0) }), entry({ ts: isoDaysAgo(3) })]);
  assert.equal(broken.streak, 1, 'eine Luecke beendet die aktuelle Serie');
  assert.equal(broken.longestStreak, 1);
}

// --- Monatsvergleich: kein Vormonat = keine Prozent-Behauptung ---------------
{
  assert.equal(insights.compute([entry()]).monthDeltaPct, null, 'ohne Vormonat kein Delta');
}

// --- Heatmap: 16 Wochen a 7 Tage, Zukunft markiert --------------------------
{
  const { heatmap } = insights.compute([entry({ words: 50 })]);
  assert.equal(heatmap.weeks.length, 16);
  assert.ok(heatmap.weeks.every((w) => w.length === 7), 'jede Woche hat 7 Tage');
  const today = insights.localDay(Date.now());
  const cells = heatmap.weeks.flat();
  assert.equal(cells.find((c) => c.day === today).level, 4, 'einziger Tag = eigenes Maximum');
  assert.ok(cells.filter((c) => c.future).every((c) => c.words === 0), 'Zukunft ist leer');
}

// --- Korrekturzaehlung -------------------------------------------------------
{
  // "aehm" raus, "ja" rein -> 2 Aenderungen. Eine reine Laengendifferenz
  // wuerde hier 0 melden.
  assert.equal(insights.countFixes('aehm das ist gut', 'das ist gut ja'), 2);
  assert.equal(insights.countFixes('das ist gut', 'das ist gut'), 0);
  assert.equal(
    insights.countDictFixes('ich nutze rif', 'ich nutze Riff', [{ term: 'Riff' }]),
    1,
    'korrigierte Schreibweise zaehlt als Woerterbuch-Treffer',
  );
  assert.equal(
    insights.countDictFixes('ich nutze Riff', 'ich nutze Riff', [{ term: 'Riff' }]),
    0,
    'schon vorher korrekt = keine Korrektur',
  );
}

// --- Snippets: nach der Leerzeichen-Normalisierung, sonst zerfaellt die Adresse
{
  const ops = resolveDictation('Schreib an meine E-Mail bitte', {
    snippets: [{ trigger: 'meine E-Mail', text: 'a.b@mail.com' }],
  });
  const out = ops.map((o) => o.value).join('');
  assert.ok(out.includes('a.b@mail.com'), `Snippet unversehrt einsetzen, war: ${out}`);
  assert.equal(applySnippets('X', []), 'X', 'ohne Snippets unveraendert');
  // Regex-Sonderzeichen im Trigger duerfen nicht als Muster wirken.
  assert.equal(applySnippets('sag c++ dazu', [{ trigger: 'c++', text: 'C-Plus-Plus' }]), 'sag C-Plus-Plus dazu');
}

// --- Format-Tokens weiterhin intakt (Regression zum Snippet-Umbau) ----------
{
  const ops = resolveDictation('erste Zeile neue Zeile zweite Zeile');
  assert.ok(ops.map((o) => o.value).join('').includes('\n'), '"neue Zeile" bleibt ein Umbruch');
}

// --- Kontext + Cleanup-Zusatz ------------------------------------------------
{
  assert.equal(categorize('WhatsApp.exe'), 'personal');
  assert.equal(categorize('Code'), 'other');
  assert.equal(categorize(''), 'other');
  // 'formal' ist das Default-Verhalten des Prompts -> kein Zusatz, kein Token
  // verschwendet. Ohne Woerterbuch bleibt der Prompt exakt wie vorher.
  assert.equal(cleanupExtras({ other: 'formal' }, 'other', []), '');
  const extras = cleanupExtras({ personal: 'very-casual' }, 'personal', [{ term: 'Riff' }]);
  assert.ok(extras.includes('lowercase') && extras.includes('Riff'));
}

// --- Onboarding: Accelerator-Parsing (Shortcut-Test-Screen) -----------------
{
  assert.deepEqual(parseAccelerator('Control+Alt'), { mods: ['Control', 'Alt'], mainKey: null }, 'Standard-Diktat-Hotkey ist reine Modifier-Kombi');
  assert.deepEqual(parseAccelerator('Control+Alt+D'), { mods: ['Control', 'Alt'], mainKey: 'D' }, 'Haupttaste getrennt von Modifiern erkannt');
  assert.equal(hotkeyLabel('Control+Alt'), 'Strg + Alt');
  assert.equal(hotkeyLabel(''), '', 'leerer Hotkey ergibt leeres Label statt Crash');
}

// --- Onboarding: Zeitersparnis nur aus echten Messwerten, nie erfunden ------
{
  assert.equal(savingsHoursPerWeek(3, 140, 40), 15, '3h/Tag, 140 vs 40 WPM -> 5/7 gespart * 21h/Woche = 15');
  assert.equal(savingsHoursPerWeek(3, 100, 100), 0, 'gleich schnell getippt wie gesprochen -> keine Ersparnis behaupten');
  assert.equal(savingsHoursPerWeek(3, 100, 120), 0, 'getippt schneller als gesprochen -> 0, nicht negativ');
  assert.equal(savingsHoursPerWeek(3, null, 40), 0, 'fehlende Messung -> 0 statt NaN');
}

// --- Stille-/Halluzinations-Filter (Nutzer-Feedback: "vielen Dank" kam ------
// trotz Filter noch durch) -----------------------------------------------
{
  const silence = pcm(new Array(16000).fill(0)); // 1s digitale Stille
  assert.ok(isSilence(silence), 'reine Stille ist still');
  assert.ok(!isSpeech(silence, 16000), 'reine Stille ist keine Sprache');
  assert.ok(!isSpeech(Buffer.alloc(0), 16000), 'leerer Puffer ist keine Sprache');

  // Kurzer lauter Klick (50ms von 1s) reisst die globale RMS nicht, koennte
  // sie aber in einer kuerzeren Aufnahme reissen - der Punkt hier ist die
  // MIN_VOICED_MS-Schwelle: zu wenige laute Samples, auch wenn sie laut sind.
  const clickSamples = new Array(16000).fill(0);
  for (let i = 0; i < 800; i++) clickSamples[i] = 20000; // 50ms laut
  const click = pcm(clickSamples);
  assert.ok(!isSpeech(click, 16000), 'ein kurzer lauter Klick ist keine Sprache (zu wenig Voiced-Dauer)');

  // "Sprache" simuliert: 500ms durchgaengig laut genug.
  const speechSamples = new Array(16000).fill(0);
  for (let i = 0; i < 8000; i++) speechSamples[i] = 12000; // 500ms
  assert.ok(isSpeech(pcm(speechSamples), 16000), '500ms durchgaengig lauter Pegel gilt als Sprache');

  assert.ok(isHallucination('Vielen Dank!'), 'bekannte Standardphrase wird erkannt');
  assert.ok(isHallucination('Vielen, vielen Dank!'), 'Kommavariante wird ueber Normalisierung erkannt');
  assert.ok(isHallucination("Danke fürs Zuschauen"), 'Apostroph-lose Variante matcht die Listenform');
  assert.ok(!isHallucination('Vielen Dank für die Info, ruf mich zurück'), 'echter Satz MIT der Phrase wird nie unterdrückt');
  assert.ok(!isHallucination('Kauf bitte Milch und Brot'), 'normaler Satz ist keine Halluzination');
}

console.log('OK — alle Pruefungen bestanden.');
