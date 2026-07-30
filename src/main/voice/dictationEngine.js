// Wandelt gesprochene Formatierungs-Kommandos (DE/EN) im bereinigten Transkript
// in echte Zeichen um, bevor getippt wird. "Letzten Satz loeschen" ist kein
// Zeichen, sondern ein eigenstaendiger Steuerbefehl - deshalb eigener Op-Typ,
// der keinen Text konsumiert/ersetzt.
const DELETE_LAST_RE = /\b(delete last sentence|lösche den letzten satz)\b/gi;

// Reihenfolge irrelevant, da die Phrasen sich nicht ueberschneiden.
const FORMAT_TOKENS = [
  [/\b(new paragraph|neuer absatz)\b/gi, '\n\n'],
  [/\b(new line|neue zeile)\b/gi, '\n'],
  [/\b(open bracket|klammer auf)\b/gi, '('],
  [/\b(close bracket|klammer zu)\b/gi, ')'],
  [/\b(full stop|period|punkt)\b/gi, '.'],
  [/\b(comma|komma)\b/gi, ','],
  [/\b(quote|anführungszeichen)\b/gi, '"'],
  [/\b(bullet|aufzählungspunkt)\b/gi, '• '],
];

function applyFormatTokens(text) {
  let out = text;
  for (const [re, value] of FORMAT_TOKENS) {
    out = out.replace(re, value);
  }
  return out;
}

// Nur Leerzeichen/Tabs anfassen, Zeilenumbrueche (aus new line/new paragraph)
// bleiben unangetastet - die sind gewollte Struktur, keine Tippfehler.
function normalizeSpacing(text) {
  let out = text;
  out = out.replace(/[ \t]+([,.)])/g, '$1'); // kein Leerzeichen vor , . )
  out = out.replace(/([,.)])(?=[^\s])/g, '$1 '); // genau eins danach vor dem naechsten Wort
  out = out.replace(/(\w)\(/g, '$1 ('); // ein Leerzeichen vor ( wenn direkt an ein Wort geklebt
  out = out.replace(/[ \t]{2,}/g, ' '); // mehrfache Leerzeichen zusammenfassen
  return out;
}

// Snippets (gesprochener Trigger -> hinterlegter Text, z.B. "meine E-Mail"
// -> die Adresse). Bewusst NACH normalizeSpacing: der eingesetzte Text ist
// woertlich gemeint, sonst wuerde aus "a.b@mail.com" ein "a. b@mail. com"
// (normalizeSpacing setzt ein Leerzeichen nach jedem Punkt).
// Reine Substring-Ersetzung statt Wortgrenzen: Trigger sind in der Praxis
// mehrwortige Phrasen, und \b greift bei Umlauten/Bindestrichen nicht
// verlaesslich.
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function applySnippets(text, snippets) {
  let out = text;
  for (const s of snippets || []) {
    if (!s.trigger || !s.text) continue;
    out = out.replace(new RegExp(escapeRe(s.trigger.trim()), 'gi'), s.text);
  }
  return out;
}

function processChunk(chunk, snippets) {
  return applySnippets(normalizeSpacing(applyFormatTokens(chunk)), snippets);
}

function resolveDictation(cleanText, { snippets = [] } = {}) {
  const ops = [];
  if (!cleanText) return ops;

  // Split trennt am Kommando-Wort und behaelt es (Capture-Gruppe) im Ergebnis -
  // gerade Indizes sind Text, ungerade sind das erkannte Kommando selbst.
  const parts = cleanText.split(DELETE_LAST_RE);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      ops.push({ kind: 'delete-last-segment' });
    } else if (parts[i] !== '') {
      ops.push({ kind: 'text', value: processChunk(parts[i], snippets) });
    }
  }

  if (ops.length === 0) ops.push({ kind: 'text', value: '' });
  return ops;
}

module.exports = { resolveDictation, applySnippets };
