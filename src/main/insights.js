// Rechnet ALLE angezeigten Zahlen aus dem Verlauf aus - eine Quelle, keine
// mitgeführten Zähler, die auseinanderlaufen können. 500 Einträge (siehe
// store.HISTORY_LIMIT) in einem Durchgang zu aggregieren ist Mikrosekunden-
// Arbeit, die Berechnung läuft also einfach bei jedem Öffnen der Ansicht.
//
// Master-Prompt §2 B: keine erfundene Metrik. Es gibt hier absichtlich KEIN
// "Top 0,1 %" wie bei Wispr Flow - die Vergleichsgruppe kennt Riff nicht. Der
// ehrliche Bezugspunkt ist TYPING_WPM: eine geübte Tippgeschwindigkeit.
const { categorize, CATEGORY_LABELS } = require('./appContext');

const TYPING_WPM = 40;
const HEATMAP_WEEKS = 16;

function localDay(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Median statt Mittelwert: ein einzelnes 3-Wort-Diktat mit 0,4s Aufnahme
// ergibt rechnerisch 450 WPM und würde jeden Mittelwert unbrauchbar machen.
function wordsPerMinute(history) {
  const rates = history
    .filter((h) => h.words >= 5 && h.durationMs >= 1500)
    .map((h) => h.words / (h.durationMs / 60000));
  return Math.round(median(rates));
}

function wordsPerDay(history) {
  const byDay = new Map();
  for (const h of history) {
    const day = localDay(h.ts);
    byDay.set(day, (byDay.get(day) || 0) + (h.words || 0));
  }
  return byDay;
}

function streaks(byDay) {
  const days = [...byDay.keys()].sort().reverse(); // neueste zuerst
  if (!days.length) return { current: 0, longest: 0 };

  const has = (d) => byDay.has(d);
  const shift = (iso, delta) => {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + delta);
    return localDay(d);
  };

  // Aktuelle Serie: zählt ab heute rückwärts. Wurde heute noch nicht diktiert,
  // darf gestern die Serie noch halten (sonst wäre jede Serie bis zum ersten
  // Diktat des Tages "gerissen").
  const today = localDay(Date.now());
  let cursor = has(today) ? today : shift(today, -1);
  let current = 0;
  while (has(cursor)) { current++; cursor = shift(cursor, -1); }

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const day of [...days].reverse()) {
    run = prev && shift(prev, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = day;
  }
  return { current, longest };
}

// 16 Wochen als Spalten, Sonntag..Samstag als Zeilen (wie im Vorbild).
// level 0-4 relativ zum eigenen Maximum - eine absolute Skala wäre für einen
// Vielschreiber und einen Gelegenheitsnutzer nie gleichzeitig lesbar.
function heatmap(byDay) {
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay())); // Samstag dieser Woche
  const start = new Date(end);
  start.setDate(start.getDate() - (HEATMAP_WEEKS * 7 - 1));

  const max = Math.max(1, ...[...byDay.values()]);
  const todayIso = localDay(today);
  const weeks = [];
  const cursor = new Date(start);
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const iso = localDay(cursor);
      const words = byDay.get(iso) || 0;
      week.push({
        day: iso,
        words,
        future: iso > todayIso,
        level: words === 0 ? 0 : Math.min(4, Math.ceil((words / max) * 4)),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  const monthLabels = weeks.map((week) => {
    const first = new Date(`${week[0].day}T12:00:00`);
    return first.getDate() <= 7 ? first.toLocaleDateString('de-DE', { month: 'short' }) : '';
  });

  return { weeks, monthLabels };
}

function appUsage(history) {
  const byCategory = new Map();
  const apps = new Set();
  for (const h of history) {
    const cat = h.appCategory || categorize(h.app);
    const row = byCategory.get(cat) || { category: cat, label: CATEGORY_LABELS[cat] || cat, sessions: 0, words: 0 };
    row.sessions++;
    row.words += h.words || 0;
    byCategory.set(cat, row);
    if (h.app) apps.add(String(h.app).toLowerCase());
  }
  const total = history.length || 1;
  const rows = [...byCategory.values()]
    .map((r) => ({ ...r, pct: Math.round((r.sessions / total) * 100) }))
    .sort((a, b) => b.sessions - a.sessions);
  return { rows, distinctApps: apps.size };
}

function monthKey(ts) { return String(ts).slice(0, 7); }

// Wortweiser Vergleich Rohtranskript <-> bereinigter Text: wie viele Woerter
// hat der Cleanup tatsaechlich angefasst (entfernte Fuellwoerter + ergaenzte/
// korrigierte Woerter). Multiset-Differenz statt Laengendifferenz, sonst
// zaehlte ein Austausch ("aehm gut" -> "gut, ja") als 0 Korrekturen.
function countFixes(raw, clean) {
  const tokens = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);
  const counts = new Map();
  for (const t of tokens(raw)) counts.set(t, (counts.get(t) || 0) + 1);
  let added = 0;
  for (const t of tokens(clean)) {
    const n = counts.get(t) || 0;
    if (n > 0) counts.set(t, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of counts.values()) removed += n;
  return added + removed;
}

// Woerterbuch-Treffer: Begriffe, die in EXAKT der hinterlegten Schreibweise
// erst im bereinigten Text stehen - also die, die der Cleanup mit Hilfe des
// Woerterbuchs gerade geradegezogen hat.
function countDictFixes(raw, clean, dictionary) {
  let n = 0;
  for (const entry of dictionary || []) {
    const term = (entry.term || '').trim();
    if (!term) continue;
    if (clean.includes(term) && !raw.includes(term)) n++;
  }
  return n;
}

function compute(history) {
  const byDay = wordsPerDay(history);
  const totalWords = history.reduce((n, h) => n + (h.words || 0), 0);
  const now = new Date();
  const thisMonth = monthKey(now.toISOString());
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = monthKey(prev.toISOString());

  let wordsThisMonth = 0;
  let wordsPrevMonth = 0;
  let fixes = 0;
  let dictFixes = 0;
  for (const h of history) {
    const m = monthKey(h.ts);
    if (m === thisMonth) wordsThisMonth += h.words || 0;
    else if (m === prevMonth) wordsPrevMonth += h.words || 0;
    fixes += h.fixes || 0;
    dictFixes += h.dictFixes || 0;
  }

  const wpm = wordsPerMinute(history);
  const { current, longest } = streaks(byDay);

  return {
    sessions: history.length,
    totalWords,
    wordsToday: byDay.get(localDay(Date.now())) || 0,
    wordsThisMonth,
    // null statt 0, wenn es keinen Vormonat zum Vergleichen gibt - die UI
    // zeigt dann keinen Prozentwert an statt "+0 %" zu behaupten.
    monthDeltaPct: wordsPrevMonth ? Math.round(((wordsThisMonth - wordsPrevMonth) / wordsPrevMonth) * 100) : null,
    wpm,
    typingWpm: TYPING_WPM,
    speedFactor: wpm ? Math.round((wpm / TYPING_WPM) * 10) / 10 : 0,
    fixes,
    dictFixes,
    streak: current,
    longestStreak: longest,
    heatmap: heatmap(byDay),
    usage: appUsage(history),
  };
}

module.exports = { compute, localDay, countFixes, countDictFixes, TYPING_WPM };
