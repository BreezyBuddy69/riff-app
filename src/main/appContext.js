// Kontext-Erkennung: welche App war beim Diktieren im Vordergrund, und was
// bedeutet das für den Stil? Ein einziger `foreground`-Helper-Call pro Session
// bedient drei Features (Master-Prompt §3 Synergie 2): Stil-Wahl,
// App-Nutzungs-Statistik und das Label im Verlauf.
//
// Prozessnamen (ohne .exe, kleingeschrieben) statt Fenstertitel: Titel
// wechseln mit dem Inhalt ("Posteingang - Outlook"), der Prozessname nicht.

const CATEGORY_BY_APP = {
  // Persönliche Messenger
  whatsapp: 'personal',
  telegram: 'personal',
  discord: 'personal',
  signal: 'personal',
  instagram: 'personal',
  messenger: 'personal',
  // Arbeit
  slack: 'work',
  teams: 'work',
  'ms-teams': 'work',
  notion: 'work',
  linear: 'work',
  jira: 'work',
  // E-Mail
  outlook: 'email',
  thunderbird: 'email',
  hxoutlook: 'email',
  mailspring: 'email',
};

const CATEGORY_LABELS = {
  personal: 'Persönliche Nachrichten',
  work: 'Arbeit',
  email: 'E-Mail',
  other: 'Sonstiges',
};

const STYLE_LABELS = {
  formal: 'Formal — Groß- und Kleinschreibung + Satzzeichen',
  casual: 'Casual — Groß- und Kleinschreibung, weniger Satzzeichen',
  'very-casual': 'Very casual — alles klein, weniger Satzzeichen',
};

// Stil-Anweisungen als Ergänzung zum bestehenden Cleanup-Prompt. 'formal' ist
// exakt das Default-Verhalten des Cleanup-Prompts - dafür wird bewusst NICHTS
// angehängt (kürzerer Prompt = weniger Tokens = schneller).
const STYLE_INSTRUCTIONS = {
  formal: '',
  casual: 'Style: keep normal capitalization but use minimal punctuation - no trailing period at the end of a short message, commas only where meaning would otherwise be unclear.',
  'very-casual': 'Style: write everything in lowercase, no trailing period, minimal punctuation. Keep proper nouns and acronyms as spoken.',
};

function categorize(appName) {
  if (!appName) return 'other';
  const key = String(appName).toLowerCase().replace(/\.exe$/, '');
  return CATEGORY_BY_APP[key] || 'other';
}

// Ab hier lohnt sich Filtern: kleinere Woerterbuecher einfach komplett
// mitschicken (Filtern selbst kostet auch Tokens/Zeit, siehe relevantTerms).
const FILTER_ABOVE = 40;

// Begrenzt die mitgeschickten Begriffe auf die, die zur aktuellen Aeusserung
// passen koennten (Nutzerwunsch Tokeneffizienz, 2026-07-30) - sonst waechst
// der Cleanup-Prompt mit jedem gelernten Begriff, obwohl in einem einzelnen
// Diktat nur eine Handvoll je ueberhaupt vorkommen kann. Grobe Heuristik:
// Anfangsbuchstaben eines Begriffs tauchen irgendwo im Rohtext auf (faengt
// auch falsch gehoerte Endungen ab, z.B. "Mikus" -> "Mikas"), kein echtes
// Phonetik-Modell.
// ponytail: Praefix-Heuristik statt Soundex/Levenshtein - austauschen, falls
// sie zu oft falsch/gar nicht matcht.
function relevantTerms(terms, rawText) {
  if (terms.length <= FILTER_ABOVE) return terms;
  const raw = (rawText || '').toLowerCase();
  const hits = terms.filter((t) => raw.includes(t.slice(0, Math.min(3, t.length)).toLowerCase()));
  return hits.length ? hits : terms.slice(0, FILTER_ABOVE);
}

// Baut den Zusatz zum Cleanup-Prompt aus Stil-Einstellung + Wörterbuch.
// Leerer String = Cleanup läuft genau wie vorher.
function cleanupExtras(styles, category, dictionary, rawText) {
  const parts = [];
  const style = styles[category] || 'casual';
  if (STYLE_INSTRUCTIONS[style]) parts.push(STYLE_INSTRUCTIONS[style]);
  const terms = relevantTerms((dictionary || []).map((d) => d.term).filter(Boolean), rawText);
  if (terms.length) {
    // Die Begriffe sind Schreibweisen-Autorität, kein Ersetzungsauftrag: das
    // Modell soll ähnlich klingende Fehlschreibungen korrigieren, aber keine
    // Begriffe erfinden, die nie gesprochen wurden.
    parts.push(`Known correct spellings (fix close phonetic matches, never insert a term that was not spoken): ${terms.join(', ')}`);
  }
  return parts.join('\n');
}

module.exports = { categorize, cleanupExtras, CATEGORY_LABELS, STYLE_LABELS, STYLE_INSTRUCTIONS };
