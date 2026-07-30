// Persistenter App-Datenspeicher: Verlauf, Wörterbuch, Snippets, Notizen,
// Transforms, Stil-Einstellungen. EINE JSON-Datei neben config.json (gleiches
// Zwei-Pfade-Prinzip: Projektordner im Dev, userData gepackt).
//
// Bewusst KEIN SQLite: better-sqlite3 zieht native Rebuilds nach sich (siehe
// Guardians electron-builder-Gotchas) und der ganze Datenbestand hier ist ein
// gedeckelter Verlauf plus vier kurze Listen - bei HISTORY_LIMIT=500 bleibt
// data.json im dreistelligen KB-Bereich. Schreiben ist entprellt, damit ein
// Diktat nie auf die Platte wartet.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const crypto = require('crypto');

const HISTORY_LIMIT = 500;
const WRITE_DEBOUNCE_MS = 400;

const DATA_PATH = app.isPackaged
  ? path.join(app.getPath('userData'), 'data.json')
  : path.join(__dirname, '..', '..', 'data.json');

const DEFAULT_STYLES = {
  // Pro Kontext eine Grammatik: 'formal' (Groß + Satzzeichen), 'casual'
  // (Groß, weniger Satzzeichen), 'very-casual' (klein, weniger Satzzeichen).
  personal: 'casual',
  work: 'formal',
  email: 'formal',
  other: 'casual',
  autoCleanup: true,
};

// Hotkeys gemessen, nicht geraten (2026-07-30), in zwei Runden:
//  1. `Super+Alt+<Ziffer>` (wie im Wispr-Vorbild) laesst sich gar nicht erst
//     registrieren - Windows belegt Win+Alt+Ziffer selbst (Sprunglisten).
//  2. `Super+Alt+<Buchstabe>` REGISTRIERT sich zwar, wird aber nie ausgeloest:
//     die Shell faengt Win-Kombinationen ab, bevor RegisterHotKey sie sieht.
//     Gegen eine Sonde gemessen - Super+Alt+P kam nie an, Alt+Shift+P schon.
// Deshalb Alt+Shift+<Buchstabe>: nachweislich registriert UND ausgeloest.
// (Alt+Shift allein schaltet das Tastaturlayout um - mit einer Haupttaste
// dazwischen bleibt der Umschalter aus.)
const DEFAULT_TRANSFORMS = [
  {
    id: 'polish',
    name: 'Polish',
    description: 'Klarer und knapper',
    accelerator: 'Alt+Shift+P',
    prompt: 'Rewrite the text so it is clearer and more concise. Keep the original language, meaning, facts and tone. Do not add new information, do not answer or comment. Output only the rewritten text.',
  },
  {
    id: 'prompt-engineer',
    name: 'Prompt Engineer',
    description: 'Baut einen präzisen Prompt',
    accelerator: 'Alt+Shift+O',
    prompt: 'Turn the text into a precise, well-structured prompt for an AI assistant: state the goal, the required context, the output format and the constraints. Keep the original language. Output only the prompt.',
  },
];

const EMPTY = {
  history: [],      // neueste zuerst
  dictionary: [],
  snippets: [],
  transforms: DEFAULT_TRANSFORMS,
  styles: DEFAULT_STYLES,
  wordFreq: {},      // { normalisiertesWort: Anzahl separater Diktate }
  ignoredTerms: [],  // vom Nutzer abgelehnte Vorschlaege - werden nie wieder vorgeschlagen
};

// Wörter, die zu oft vorkommen, um ein sinnvoller Wörterbuch-Vorschlag zu sein
// (Fuellwoerter, die der Cleanup nicht immer erwischt). Keine vollstaendige
// Stopwortliste, nur die haeufigsten Stoerenfriede.
// ponytail: kurze Handliste statt NLP-Stopwortkorpus - erweitern, falls
// Vorschlaege spuerbar mit Fuellwoertern zumuellen.
const SUGGESTION_STOPWORDS = new Set([
  'können', 'konnte', 'wurde', 'werden', 'haben', 'machen', 'einfach',
  'eigentlich', 'vielleicht', 'natürlich', 'wahrscheinlich', 'deswegen',
  'trotzdem', 'immer', 'schon', 'jetzt', 'heute', 'gerade', 'wieder',
  'sollte', 'müssen', 'dieser', 'diese', 'dieses', 'dabei', 'damit',
  'davon', 'daher', 'irgendwie', 'ungefähr', 'insgesamt', 'zusammen',
  'zwischen', 'während', 'nachdem', 'bisschen', 'ziemlich', 'übrigens',
]);
const SUGGESTION_MIN_WORD_LEN = 5;
const SUGGESTION_THRESHOLD = 3; // ab so vielen separaten Diktaten wird ein Wort vorgeschlagen

// Frueher ausgelieferte Vorgaben, die unter Windows nachweislich nicht
// funktionieren (siehe Kommentar bei DEFAULT_TRANSFORMS). Wer die App in dem
// Zeitfenster gestartet hat, hat sie schon in data.json stehen und saehe sonst
// dauerhaft entweder "Kombination belegt" oder - schlimmer - einen Hotkey, der
// stillschweigend nichts tut. Angefasst werden ausschliesslich die beiden
// eingebauten Transforms mit exakt einer dieser alten Kombinationen; eine
// selbst gewaehlte Kombination bleibt IMMER unberuehrt.
const SUPERSEDED = {
  polish: ['Super+Alt+1', 'Super+Alt+P'],
  'prompt-engineer': ['Super+Alt+2', 'Super+Alt+O'],
};

function migrateTransforms(list) {
  for (const t of list) {
    if ((SUPERSEDED[t.id] || []).includes(t.accelerator)) {
      t.accelerator = DEFAULT_TRANSFORMS.find((d) => d.id === t.id).accelerator;
    }
  }
  return list;
}

let data = null;
let writeTimer = null;

function newId() { return crypto.randomBytes(6).toString('hex'); }

function load() {
  if (data) return data;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8').replace(/^﻿/, ''));
    data = {
      history: Array.isArray(raw.history) ? raw.history : [],
      dictionary: Array.isArray(raw.dictionary) ? raw.dictionary : [],
      snippets: Array.isArray(raw.snippets) ? raw.snippets : [],
      transforms: Array.isArray(raw.transforms) && raw.transforms.length
        ? migrateTransforms(raw.transforms)
        : structuredClone(DEFAULT_TRANSFORMS),
      styles: { ...DEFAULT_STYLES, ...(raw.styles || {}) },
      wordFreq: raw.wordFreq && typeof raw.wordFreq === 'object' ? raw.wordFreq : {},
      ignoredTerms: Array.isArray(raw.ignoredTerms) ? raw.ignoredTerms : [],
    };
  } catch (err) {
    // Unlesbar oder nicht vorhanden: mit Defaults weiterarbeiten. Ein kaputter
    // Datenspeicher darf das Diktieren nie blockieren (Master-Prompt §2 C15).
    if (fs.existsSync(DATA_PATH)) console.warn('[store] data.json unlesbar, nutze Defaults:', err.message);
    data = structuredClone(EMPTY);
  }
  return data;
}

function flush() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!data) return;
  try {
    fs.writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  } catch (err) {
    console.warn('[store] Schreiben fehlgeschlagen:', err.message);
  }
}

function scheduleWrite() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, WRITE_DEBOUNCE_MS);
}

// ---------- Verlauf ----------

// entry: { app, appCategory, mode, raw, text, words, durationMs, fixes, dictFixes }
function addHistory(entry) {
  const d = load();
  const row = { id: newId(), ts: new Date().toISOString(), ...entry };
  d.history.unshift(row);
  if (d.history.length > HISTORY_LIMIT) d.history.length = HISTORY_LIMIT;
  scheduleWrite();
  return row;
}

function deleteHistory(id) {
  const d = load();
  const before = d.history.length;
  d.history = d.history.filter((h) => h.id !== id);
  if (d.history.length !== before) scheduleWrite();
  return d.history.length !== before;
}

function clearHistory() {
  const d = load();
  d.history = [];
  scheduleWrite();
}

// ---------- Generische Listen (dictionary/snippets/transforms) ----------

const LISTS = new Set(['dictionary', 'snippets', 'transforms']);

function listAdd(name, fields) {
  if (!LISTS.has(name)) throw new Error(`Unbekannte Liste: ${name}`);
  const d = load();
  const row = { id: newId(), ts: new Date().toISOString(), ...fields };
  d[name].unshift(row);
  scheduleWrite();
  return row;
}

function listUpdate(name, id, fields) {
  if (!LISTS.has(name)) throw new Error(`Unbekannte Liste: ${name}`);
  const d = load();
  const row = d[name].find((r) => r.id === id);
  if (!row) return null;
  Object.assign(row, fields, { updatedAt: new Date().toISOString() });
  scheduleWrite();
  return row;
}

function listRemove(name, id) {
  if (!LISTS.has(name)) throw new Error(`Unbekannte Liste: ${name}`);
  const d = load();
  const before = d[name].length;
  d[name] = d[name].filter((r) => r.id !== id);
  if (d[name].length !== before) scheduleWrite();
  return d[name].length !== before;
}

// ---------- Wörterbuch-Vorschläge ----------
// Nutzerwunsch (2026-07-30): Riff soll oft gesagte Woerter selbst erkennen
// und als Vorschlag anbieten, statt dass der Nutzer sie manuell eintraegt.
// Zaehlt pro Diktat jedes ungewoehnliche Wort HOECHSTENS einmal (sonst
// taeuscht ein einzelner Satz mit Wortwiederholung mehrere "Sitzungen" vor).

function learnWords(cleanedText, dictionary) {
  const d = load();
  const known = new Set((dictionary || []).map((e) => (e.term || '').toLowerCase()));
  const ignored = new Set(d.ignoredTerms);
  const seenInUtterance = new Set();
  const words = String(cleanedText || '').match(/\p{L}[\p{L}'-]*/gu) || [];
  for (const w of words) {
    const norm = w.toLowerCase();
    if (norm.length < SUGGESTION_MIN_WORD_LEN) continue;
    if (SUGGESTION_STOPWORDS.has(norm)) continue;
    if (known.has(norm) || ignored.has(norm)) continue;
    if (seenInUtterance.has(norm)) continue;
    seenInUtterance.add(norm);
    d.wordFreq[norm] = (d.wordFreq[norm] || 0) + 1;
  }
  if (seenInUtterance.size) scheduleWrite();
}

// Gibt Woerter zurueck, die die Schwelle erreicht haben - mit der zuletzt im
// Rohtext gesehenen Schreibweise (Grossschreibung), damit ein Vorschlag nicht
// in Kleinbuchstaben im Wörterbuch landet.
function suggestions() {
  const d = load();
  return Object.entries(d.wordFreq)
    .filter(([, count]) => count >= SUGGESTION_THRESHOLD)
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count);
}

function dismissSuggestion(term) {
  const d = load();
  const norm = String(term || '').toLowerCase();
  delete d.wordFreq[norm];
  if (!d.ignoredTerms.includes(norm)) d.ignoredTerms.push(norm);
  scheduleWrite();
}

// Ein angenommener Vorschlag ist kein Kandidat mehr, egal ob er ueber
// listAdd('dictionary', ...) oder die Vorschlagsliste hinzugefuegt wurde.
function acceptSuggestion(term) {
  const d = load();
  delete d.wordFreq[String(term || '').toLowerCase()];
  scheduleWrite();
  return listAdd('dictionary', { term });
}

// ---------- Stil ----------

function setStyles(partial) {
  const d = load();
  Object.assign(d.styles, partial);
  scheduleWrite();
  return d.styles;
}

module.exports = {
  DATA_PATH, HISTORY_LIMIT, DEFAULT_TRANSFORMS,
  load, flush,
  addHistory, deleteHistory, clearHistory,
  listAdd, listUpdate, listRemove,
  learnWords, suggestions, dismissSuggestion, acceptSuggestion,
  setStyles,
  get history() { return load().history; },
  get dictionary() { return load().dictionary; },
  get snippets() { return load().snippets; },
  get transforms() { return load().transforms; },
  get styles() { return load().styles; },
};
