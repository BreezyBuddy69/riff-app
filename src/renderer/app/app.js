// Riff-Oberflaeche. Kein Framework (gleiche Grammatik wie der Rest von Riff):
// ein Zustand vom Main-Prozess, eine Render-Funktion pro View, DOM-Aufbau
// ueber node() statt innerHTML - Nutzertexte (Verlauf, Notizen, Snippets)
// landen ausschliesslich als textContent im Dokument.

const $ = (id) => document.getElementById(id);

function node(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v; // nur fuer feste, eigene Markup-Schnipsel
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

const num = (n) => Number(n || 0).toLocaleString('de-CH');

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2000);
}

// ---------- Zustand ----------

let S = null;              // kompletter Zustand aus dem Main-Prozess
let view = 'dictation';
let historyQuery = '';
let styleTab = 'personal';
let editingTransform = null; // null = Formular zu, '' = neu, id = bearbeiten

async function reload() { apply(await window.riff.state()); }

function apply(state) {
  S = state;
  render();
}

function go(next) {
  view = next;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === next);
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${next}`);
  $('main').scrollTop = 0;
  render();
}

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-view]');
  if (target) go(target.dataset.view);
});

// ---------- Render ----------

function render() {
  if (!S) return;
  renderChrome();
  const map = {
    dictation: renderDictation,
    insights: renderInsights,
    dictionary: renderDictionary,
    snippets: renderSnippets,
    style: renderStyle,
    transforms: renderTransforms,
    account: renderAccount,
    settings: renderSettings,
  };
  map[view]?.();
}

function renderChrome() {
  const pro = S.tier === 'pro';
  const badge = $('tierBadge');
  badge.textContent = pro ? 'Pro' : 'Basic';
  badge.classList.toggle('pro', pro);
  $('accountNavLabel').textContent = S.account.signedIn ? (S.account.name || S.account.email) : 'Konto';

  const card = $('quotaCard');
  card.classList.toggle('pro', pro);
  if (pro) {
    $('quotaHeadline').textContent = 'Unbegrenzt';
    $('quotaHint').textContent = 'Pro ist aktiv — kein Wochenlimit.';
    $('quotaCta').hidden = true;
  } else {
    const left = Math.max(0, S.weeklyLimit - S.quota.wordsUsed);
    $('quotaHeadline').textContent = `${num(left)} Wörter übrig`;
    $('quotaHint').textContent = `${num(S.weeklyLimit)} Wörter pro Woche. Montags neu.`;
    $('quotaCta').hidden = false;
  }
}

// ---------- Diktat ----------

const DAY_MS = 86400000;

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / DAY_MS);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}

function modeLabel(mode) { return mode === 'toggle' ? 'Doppel-Tap' : 'Halten'; }

function renderDictation() {
  const name = S.account.name || S.account.email.split('@')[0] || '';
  $('greeting').textContent = name ? `Willkommen zurück, ${name}` : 'Willkommen zurück';
  $('statWords').textContent = num(S.insights.totalWords);
  $('statWpm').textContent = S.insights.wpm || '–';
  $('statStreak').textContent = S.insights.streak;
  $('statStreakLabel').textContent = S.insights.streak === 1 ? 'Tag Serie' : 'Tage Serie';

  const q = historyQuery.trim().toLowerCase();
  const rows = q ? S.history.filter((h) => (h.text || '').toLowerCase().includes(q)) : S.history;
  $('historyHeading').textContent = q ? `${rows.length} Treffer` : 'Verlauf';

  const list = $('historyList');
  list.replaceChildren();
  if (!rows.length) {
    list.append(node('div', { class: 'empty', text: q ? 'Kein Diktat passt zur Suche.' : 'Noch kein Diktat. Halte den Shortcut gedrückt und sprich — der Text landet dort, wo dein Cursor steht.' }));
    return;
  }

  let lastDay = '';
  for (const h of rows) {
    const label = dayLabel(h.ts);
    if (label !== lastDay) {
      list.append(node('div', { class: 'day-label', text: label }));
      lastDay = label;
    }
    const wpm = h.durationMs >= 1500 && h.words ? Math.round(h.words / (h.durationMs / 60000)) : null;
    const meta = [
      h.app || 'unbekannte App',
      modeLabel(h.mode),
      `${h.words} Wörter`,
      wpm ? `${wpm} WPM` : null,
      h.fixes ? `${h.fixes} Korrekturen` : null,
    ].filter(Boolean).join(' · ');

    list.append(node('div', { class: 'row' }, [
      node('div', { class: 'time', text: new Date(h.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) }),
      node('div', { class: 'body' }, [
        node('div', { class: 'text', text: h.text || '(leer)' }),
        node('div', { class: 'meta', text: meta }),
      ]),
      node('div', { class: 'actions' }, [
        node('button', {
          class: 'icon-btn', type: 'button', title: 'Kopieren',
          onclick: () => { window.riff.copy(h.text); toast('Kopiert.'); },
        }, '⧉'),
        node('button', {
          class: 'icon-btn danger', type: 'button', title: 'Löschen',
          onclick: async () => apply(await window.riff.deleteHistory(h.id)),
        }, '✕'),
      ]),
    ]));
  }
}

$('historySearch').addEventListener('input', (e) => { historyQuery = e.target.value; renderDictation(); });
$('clearHistory').addEventListener('click', async () => {
  if (!S.history.length) return;
  apply(await window.riff.clearHistory());
  toast('Verlauf gelöscht.');
});

// ---------- Insights ----------

const GAUGE_LEN = 158;
const GAUGE_MAX_WPM = 220; // Skalenende; darueber laeuft der Bogen voll aus

function renderInsights() {
  const i = S.insights;
  $('insWpm').textContent = i.wpm || 0;
  const pct = Math.min(1, (i.wpm || 0) / GAUGE_MAX_WPM);
  $('gaugeFill').style.strokeDashoffset = String(GAUGE_LEN * (1 - pct));
  $('insWpmNote').textContent = i.wpm
    ? `${i.speedFactor}× so schnell wie Tippen (${i.typingWpm} WPM). Median über ${i.sessions} Diktate.`
    : 'Noch keine Messung — diktiere einen Satz mit mindestens fünf Wörtern.';

  $('insFixes').textContent = num(i.fixes + i.dictFixes);
  $('insFixesWords').textContent = num(i.fixes);
  $('insDictFixes').textContent = num(i.dictFixes);

  $('insTotalWords').textContent = num(i.totalWords);
  $('insSessions').textContent = num(i.sessions);
  $('insToday').textContent = num(i.wordsToday);
  const delta = $('insMonthDelta');
  if (i.monthDeltaPct === null) delta.hidden = true;
  else {
    delta.hidden = false;
    delta.textContent = `${i.monthDeltaPct >= 0 ? '+' : ''}${i.monthDeltaPct} % zum Vormonat`;
    delta.classList.toggle('down', i.monthDeltaPct < 0);
  }

  $('insApps').textContent = `${i.usage.distinctApps} ${i.usage.distinctApps === 1 ? 'App' : 'Apps'}`;
  const bars = $('usageBars');
  bars.replaceChildren();
  if (!i.usage.rows.length) {
    bars.append(node('div', { class: 'empty', text: 'Noch keine Daten.' }));
  } else {
    for (const r of i.usage.rows) {
      bars.append(node('div', { class: 'bar-row' }, [
        node('span', { class: 'label', text: r.label }),
        node('div', { class: 'track' }, [
          node('div', { class: 'fill', style: `width:${Math.max(4, r.pct)}%`, text: `${r.pct}%` }),
        ]),
        node('span', { class: 'count', text: `${num(r.sessions)} Diktate` }),
      ]));
    }
  }

  $('insStreak').textContent = i.streak;
  $('insLongest').textContent = i.longestStreak;
  const months = $('heatMonths');
  const heat = $('heatmap');
  months.replaceChildren(...i.heatmap.monthLabels.map((m) => node('span', { text: m })));
  heat.replaceChildren();
  for (const week of i.heatmap.weeks) {
    for (const day of week) {
      const cls = day.future ? 'future' : (day.level ? `l${day.level}` : '');
      heat.append(node('i', {
        class: cls,
        title: day.future ? '' : `${new Date(`${day.day}T12:00:00`).toLocaleDateString('de-DE')}: ${day.words} Wörter`,
      }));
    }
  }
}

// ---------- Wörterbuch / Snippets ----------

function renderList(container, items, renderRow, emptyText) {
  const el = $(container);
  el.replaceChildren();
  if (!items.length) { el.append(node('div', { class: 'empty', text: emptyText })); return; }
  for (const item of items) el.append(renderRow(item));
}

function renderDictSuggestions() {
  const wrap = $('dictSuggestionsWrap');
  const list = S.dictSuggestions || [];
  wrap.style.display = list.length ? '' : 'none';
  renderList('dictSuggestions', list, (s) => node('div', { class: 'row' }, [
    node('div', { class: 'body' }, [
      node('div', { class: 'term', text: s.term }),
      node('div', { class: 'term-note', text: `${s.count}× gesagt` }),
    ]),
    node('div', { class: 'actions' }, [
      node('button', {
        class: 'icon-btn', type: 'button', title: 'Hinzufügen',
        onclick: async () => { apply(await window.riff.acceptDictSuggestion(s.term)); toast('Begriff hinzugefügt.'); },
      }, '✓'),
      node('button', {
        class: 'icon-btn danger', type: 'button', title: 'Verwerfen',
        onclick: async () => apply(await window.riff.dismissDictSuggestion(s.term)),
      }, '✕'),
    ]),
  ]), '');
}

function renderDictionary() {
  renderDictSuggestions();
  renderList('dictList', S.dictionary, (d) => node('div', { class: 'row' }, [
    node('div', { class: 'body' }, [
      node('div', { class: 'term', text: d.term }),
      d.note ? node('div', { class: 'term-note', text: d.note }) : null,
    ]),
    node('div', { class: 'actions' }, [
      node('button', {
        class: 'icon-btn danger', type: 'button', title: 'Löschen',
        onclick: async () => apply(await window.riff.listRemove('dictionary', d.id)),
      }, '✕'),
    ]),
  ]), 'Noch keine Begriffe. Trage Namen ein, die die Erkennung regelmäßig falsch schreibt.');
}

$('dictForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const term = $('dictTerm').value.trim();
  if (!term) return;
  apply(await window.riff.listAdd('dictionary', { term, note: $('dictNote').value.trim() }));
  $('dictTerm').value = '';
  $('dictNote').value = '';
  toast('Begriff hinzugefügt.');
});

function renderSnippets() {
  renderList('snipList', S.snippets, (s) => node('div', { class: 'row' }, [
    node('div', { class: 'body' }, [
      node('div', { class: 'term', text: `„${s.trigger}“` }),
      node('div', { class: 'term-note', text: s.text }),
    ]),
    node('div', { class: 'actions' }, [
      node('button', {
        class: 'icon-btn danger', type: 'button', title: 'Löschen',
        onclick: async () => apply(await window.riff.listRemove('snippets', s.id)),
      }, '✕'),
    ]),
  ]), 'Noch keine Snippets.');
}

$('snipForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const trigger = $('snipTrigger').value.trim();
  const text = $('snipText').value;
  if (!trigger || !text.trim()) return;
  apply(await window.riff.listAdd('snippets', { trigger, text }));
  $('snipTrigger').value = '';
  $('snipText').value = '';
  toast('Snippet hinzugefügt.');
});

// ---------- Stil ----------

const STYLE_SAMPLES = {
  formal: 'Hey, hast du morgen Zeit für ein Mittagessen? Wir könnten um 12 Uhr, wenn das für dich passt.',
  casual: 'Hey hast du morgen Zeit für ein Mittagessen? Wir könnten um 12 wenn das für dich passt',
  'very-casual': 'hey hast du morgen zeit für ein mittagessen wir könnten um 12 wenn das für dich passt',
};

const STYLE_NAMES = {
  formal: ['Formal', 'Groß-/Kleinschreibung + Satzzeichen'],
  casual: ['Casual', 'Groß-/Kleinschreibung, weniger Satzzeichen'],
  'very-casual': ['Very casual', 'alles klein, weniger Satzzeichen'],
};

const CONTEXT_HINTS = {
  personal: 'WhatsApp, Telegram, Discord, Signal, Instagram',
  work: 'Slack, Teams, Notion, Linear, Jira',
  email: 'Outlook, Thunderbird, Mailspring',
  other: 'Alles andere — Editoren, Browser, Terminals',
};

function renderStyle() {
  const tabs = $('styleTabs');
  tabs.replaceChildren(...Object.entries(S.categoryLabels).map(([key, label]) => node('button', {
    type: 'button',
    class: `tab${styleTab === key ? ' active' : ''}`,
    onclick: () => { styleTab = key; renderStyle(); },
  }, label)));

  $('styleContextTitle').textContent = `Dieser Stil gilt in: ${S.categoryLabels[styleTab]}`;
  $('styleContextHint').textContent = `${CONTEXT_HINTS[styleTab]}. Riff erkennt die App, die beim Diktieren im Vordergrund war.`;

  const cards = $('styleCards');
  cards.replaceChildren(...Object.keys(STYLE_NAMES).map((key) => {
    const [name, desc] = STYLE_NAMES[key];
    return node('button', {
      type: 'button',
      class: `pick${S.styles[styleTab] === key ? ' active' : ''}`,
      onclick: async () => { apply(await window.riff.setStyles({ [styleTab]: key })); toast('Stil gespeichert.'); },
    }, [
      node('strong', { text: name }),
      node('span', { text: desc }),
      node('div', { class: 'sample', text: STYLE_SAMPLES[key] }),
    ]);
  }));

  $('autoCleanup').checked = S.styles.autoCleanup !== false;
}

$('autoCleanup').addEventListener('change', async (e) => {
  apply(await window.riff.setStyles({ autoCleanup: e.target.checked }));
});

// ---------- Transforms ----------

function renderTransforms() {
  $('transformsEnabled').checked = S.config.transforms.enabled;

  const issues = $('transformIssues');
  if (S.config.transforms.enabled && S.transformIssues.length) {
    issues.hidden = false;
    issues.textContent = `Belegt von einer anderen App: ${S.transformIssues.map((t) => `${t.name} (${t.accelerator})`).join(', ')} — andere Kombination wählen.`;
  } else {
    issues.hidden = true;
  }

  const cards = $('transformCards');
  cards.replaceChildren();
  for (const t of S.transforms) {
    cards.append(node('div', { class: 'tf-card' }, [
      node('div', { class: 'tf-keys' }, (t.accelerator || '').split('+').filter(Boolean).map((k) => node('kbd', { text: k }))),
      node('strong', { text: t.name }),
      node('p', { text: t.description || '' }),
      node('div', { class: 'editor-actions' }, [
        node('button', {
          class: 'btn-ghost small', type: 'button',
          onclick: () => openTransformEditor(t.id),
        }, 'Bearbeiten'),
        node('button', {
          class: 'btn-ghost small danger', type: 'button',
          onclick: async () => {
            apply(await window.riff.listRemove('transforms', t.id));
            apply(await window.riff.refreshTransforms());
          },
        }, 'Löschen'),
      ]),
    ]));
  }
  cards.append(node('div', { class: 'tf-card new' }, [
    node('strong', { text: '+ Eigener Transform' }),
    node('p', { text: 'Name, Hotkey, Anweisung — fertig.' }),
    node('div', { class: 'editor-actions' }, [
      node('button', { class: 'btn-ghost small', type: 'button', onclick: () => openTransformEditor('') }, 'Anlegen'),
    ]),
  ]));

  const form = $('transformForm');
  form.hidden = editingTransform === null;
  if (editingTransform !== null) {
    const t = S.transforms.find((x) => x.id === editingTransform) || {};
    $('transformFormTitle').textContent = editingTransform ? `„${t.name}“ bearbeiten` : 'Neuer Transform';
    $('tfName').value = t.name || '';
    $('tfDesc').value = t.description || '';
    $('tfAccel').value = t.accelerator || '';
    $('tfPrompt').value = t.prompt || '';
  }
}

function openTransformEditor(id) {
  editingTransform = id;
  renderTransforms();
  $('transformForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('transformsEnabled').addEventListener('change', async (e) => {
  apply(await window.riff.save({ transforms: { enabled: e.target.checked } }));
  if (e.target.checked && S.transformIssues.length) toast('Manche Hotkeys sind belegt.');
});

$('tfCancel').addEventListener('click', () => { editingTransform = null; renderTransforms(); });

$('transformForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fields = {
    name: $('tfName').value.trim(),
    description: $('tfDesc').value.trim(),
    accelerator: $('tfAccel').value.trim(),
    prompt: $('tfPrompt').value.trim(),
  };
  if (!fields.name || !fields.prompt) return;
  if (editingTransform) await window.riff.listUpdate('transforms', editingTransform, fields);
  else await window.riff.listAdd('transforms', fields);
  editingTransform = null;
  apply(await window.riff.refreshTransforms());
  toast('Transform gespeichert.');
});

// ---------- Konto ----------

let authMode = 'login';

function renderAccount() {
  const signedIn = S.account.signedIn;
  $('accountSignedOut').hidden = signedIn;
  $('accountSignedIn').hidden = !signedIn;
  if (!signedIn) renderAuthMode();
  if (signedIn) {
    const label = S.account.name || S.account.email;
    $('accountName').textContent = label;
    $('accountEmail').textContent = S.account.email;
    $('accountAvatar').textContent = (label[0] || 'R').toUpperCase();
  }
  $('accountTier').textContent = S.tier === 'pro'
    ? 'Pro — unbegrenztes Diktieren.'
    : `Free — ${num(S.quota.wordsUsed)} von ${num(S.weeklyLimit)} Wörtern diese Woche genutzt.`;
}

// Der geteilte n8n-Auth-Workflow ("Accounts — Auth", auch von Guardian
// genutzt) liefert fertige, zweisprachige Meldungen im Feld `reply` - keine
// Fehlercodes. Also wird die Servermeldung angezeigt statt sie in eine eigene
// Code-Tabelle zu uebersetzen, die bei jeder Workflow-Aenderung veraltet.
// Nur die deutsche Haelfte vor dem " / " ist fuer diese Oberflaeche relevant.
function replyText(res, fallback) {
  const raw = res && res.reply ? String(res.reply) : '';
  return raw ? raw.split(' / ')[0] : fallback;
}

// resetStep: 'request' = E-Mail eintragen, Code anfordern
//            'confirm' = Code + neues Passwort setzen
let resetStep = 'request';

function renderAuthMode() {
  const isSignup = authMode === 'signup';
  const isReset = authMode === 'reset';
  for (const t of document.querySelectorAll('#authTabs .tab')) t.classList.toggle('active', t.dataset.mode === authMode);
  $('authNameField').hidden = !isSignup;
  $('authPasswordField').hidden = isReset;
  $('authCodeField').hidden = !(isReset && resetStep === 'confirm');
  $('authNewPasswordField').hidden = !(isReset && resetStep === 'confirm');
  $('authPassword').required = !isReset;
  $('authSubmit').textContent = isSignup
    ? 'Konto erstellen'
    : isReset
      ? (resetStep === 'request' ? 'Code senden' : 'Neues Passwort setzen')
      : 'Anmelden';
  $('authPassword').setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');
  $('authHint').textContent = isReset
    ? (resetStep === 'request'
      ? 'Wir schicken dir einen Code an diese Adresse — falls es dazu ein Konto gibt.'
      : 'Code aus der E-Mail eintragen und ein neues Passwort setzen.')
    : 'Mindestens 8 Zeichen.';
  $('authError').hidden = true;
}

for (const tab of document.querySelectorAll('#authTabs .tab')) {
  tab.addEventListener('click', () => {
    authMode = tab.dataset.mode;
    resetStep = 'request';
    $('authNote').hidden = true;
    renderAuthMode();
  });
}

function authFail(res, fallback) {
  const err = $('authError');
  err.hidden = false;
  err.textContent = replyText(res, fallback);
}

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('authEmail').value.trim();
  const btn = $('authSubmit');
  btn.disabled = true;
  try {
    if (authMode === 'reset') {
      if (resetStep === 'request') {
        const res = await window.riff.requestReset({ email });
        if (!res.ok) return authFail(res, 'Anfrage fehlgeschlagen.');
        resetStep = 'confirm';
        renderAuthMode();
        const note = $('authNote');
        note.hidden = false;
        // Absichtlich unverbindlich formuliert: der Workflow verraet nie, ob
        // es zu der Adresse ein Konto gibt (anti-enumeration).
        note.textContent = replyText(res, 'Falls es ein Konto gibt, ist der Code unterwegs.');
        return;
      }
      const res = await window.riff.confirmReset({
        email,
        code: $('authCode').value.trim(),
        newPassword: $('authNewPassword').value,
      });
      if (!res.ok) return authFail(res, 'Code oder Passwort abgelehnt.');
      $('authNewPassword').value = '';
      $('authCode').value = '';
      await reload();
      toast('Passwort geändert — du bist angemeldet.');
      return;
    }

    const creds = { email, password: $('authPassword').value, name: $('authName').value.trim() };
    const res = authMode === 'signup' ? await window.riff.signup(creds) : await window.riff.login(creds);
    if (!res.ok) return authFail(res, 'Anmeldung fehlgeschlagen.');
    $('authPassword').value = '';
    await reload();
    toast(`Angemeldet als ${res.account.name || res.account.email}.`);
  } finally {
    btn.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  await window.riff.logout();
  await reload();
  toast('Abgemeldet.');
});

$('redeemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('licenseCode').value.trim();
  if (!code) return;
  const result = await window.riff.redeemCode(code);
  if (result.ok) {
    $('licenseCode').value = '';
    toast('Code eingelöst — Pro ist aktiv.');
  } else {
    const messages = {
      not_found: 'Code unbekannt.',
      already_redeemed: 'Dieser Code wurde bereits von jemand anderem eingelöst.',
      invalid_format: 'Ungültiges Code-Format.',
      rate_limited: 'Zu viele Versuche — kurz warten.',
      server_error: 'Server nicht erreichbar. Später erneut versuchen.',
    };
    toast(messages[result.reason] || 'Einlösen fehlgeschlagen.');
  }
  await reload();
});

// ---------- Einstellungen ----------

function renderSettings() {
  $('flowHold').value = S.config.hotkeys.flowHold;
  $('flowToggle').value = S.config.hotkeys.flowToggle;
  $('language').value = S.config.voice.language;
  $('noiseSuppression').checked = S.config.voice.noiseSuppression;
  $('openRouterApiKey').value = S.config.voice.openRouterApiKey;
  $('bubbleEnabled').checked = S.config.voice.bubbleEnabled !== false;
  $('idleBubbleEnabled').checked = !!S.config.voice.idleBubbleEnabled;
  $('soundsEnabled').checked = !!S.config.voice.sounds.enabled;
  $('soundsVolume').value = S.config.voice.sounds.volume;
  $('autostart').checked = S.autostart;
  $('showWindowOnStartup').checked = S.config.general.showWindowOnStartup;
  refreshMicDevices();
}

// Geraeteliste ist erst nach einer erteilten Mikrofon-Berechtigung mit
// Klarnamen befuellt (z.B. aus dem Onboarding-Mikrofontest) - ohne das bleiben
// es anonyme "Mikrofon 1/2/...", was hier bewusst in Kauf genommen wird statt
// bei jedem Settings-Aufruf ungefragt eine Berechtigung einzufordern.
async function refreshMicDevices() {
  const select = $('settingsMicDevice');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    select.replaceChildren(
      node('option', { value: '' }, 'Standardmikrofon'),
      ...inputs.map((d, i) => node('option', { value: d.deviceId }, d.label || `Mikrofon ${i + 1}`)),
    );
    select.value = S.config.voice.audioDeviceId || '';
  } catch { /* Geraeteliste ist rein kosmetisch - kein harter Fehler */ }
}

$('btnRefreshMics').addEventListener('click', refreshMicDevices);

$('save').addEventListener('click', async () => {
  apply(await window.riff.save({
    hotkeys: {
      flowHold: $('flowHold').value.trim(),
      flowToggle: $('flowToggle').value.trim(),
    },
    voice: {
      language: $('language').value.trim(),
      noiseSuppression: $('noiseSuppression').checked,
      openRouterApiKey: $('openRouterApiKey').value.trim(),
      audioDeviceId: $('settingsMicDevice').value,
      bubbleEnabled: $('bubbleEnabled').checked,
      idleBubbleEnabled: $('idleBubbleEnabled').checked,
      sounds: { enabled: $('soundsEnabled').checked, volume: Number($('soundsVolume').value) },
    },
    general: {
      showWindowOnStartup: $('showWindowOnStartup').checked,
    },
  }));
  const el = $('settingsStatus');
  el.textContent = 'Gespeichert.';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
});

$('autostart').addEventListener('change', async (e) => {
  // Autostart kann fehlschlagen - Checkbox spiegelt den echten Zustand.
  e.target.checked = await window.riff.toggleAutostart();
});

$('openFolder').addEventListener('click', () => window.riff.openConfigFolder());
$('restartApp').addEventListener('click', () => window.riff.restartApp());
$('quitApp').addEventListener('click', () => window.riff.quitApp());

// ---------- Shortcut-Recorder (D37/D11/D13) ----------
// Roter Knopf -> naechste Tastenkombination wird als Accelerator-String
// erfasst. Zwei Ziel-Grammatiken: die Diktat-Hotkeys gehen an RiffHelper.ps1
// ("Win"), Transform-Hotkeys an Electrons globalShortcut ("Super").
const MOD_KEY = {
  ControlLeft: 'Control', ControlRight: 'Control',
  AltLeft: 'Alt', AltRight: 'Alt',
  ShiftLeft: 'Shift', ShiftRight: 'Shift',
  MetaLeft: 'Meta', MetaRight: 'Meta',
};
// Windows-Konvention (Win zuerst), damit eine aufgenommene Kombination genauso
// aussieht wie die Vorgabe: "Super+Alt+P", nicht "Alt+Super+P". Die reine
// Modifier-Kombi fuer den Diktat-Hotkey bleibt dadurch unveraendert
// "Control+Alt" - wichtig, weil holdWatcher.js genau auf diesen String seine
// AltGr-Schnellerkennung stuetzt (D14).
const MOD_ORDER = ['Meta', 'Control', 'Alt', 'Shift'];
const UMLAUTS = ['ä', 'ö', 'ü'];
// Wer 3 Tasten aufnehmen will (z.B. Control+Alt+D), haelt sie in der Praxis
// selten alle im exakt gleichen Millisekunden-Fenster - oft werden die
// Modifier kurz VOR der Haupttaste losgelassen. Ohne Gnadenfrist finalisiert
// onRecordKeyup in dem Moment als reine Modifier-Kombi und die danach kommende
// Haupttaste faellt unter den Tisch (D11).
const RELEASE_GRACE_MS = 350;

let recordingTarget = null;
let recordingBefore = '';
const heldMods = new Set();
const maxMods = new Set();
let releaseTimer = null;

function metaName(targetId) { return targetId === 'tfAccel' ? 'Super' : 'Win'; }

function mainKeyName(e) {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(e.code)) return e.code;
  // e.key statt e.code: Umlaute sitzen je nach Layout (DE/AT/CH) an
  // unterschiedlichen physischen Positionen (D13).
  if (UMLAUTS.includes(e.key.toLowerCase())) return e.key.toUpperCase();
  return null;
}

function comboOf(targetId, key) {
  const mods = MOD_ORDER.filter((m) => maxMods.has(m)).map((m) => (m === 'Meta' ? metaName(targetId) : m));
  return [...mods, key].filter(Boolean).join('+');
}

function stopRecording() {
  if (!recordingTarget) return;
  clearTimeout(releaseTimer);
  releaseTimer = null;
  $(`rec-${recordingTarget}`).classList.remove('recording');
  recordingTarget = null;
  heldMods.clear();
  maxMods.clear();
  window.removeEventListener('keydown', onRecordKeydown, true);
  window.removeEventListener('keyup', onRecordKeyup, true);
  window.removeEventListener('blur', onRecordBlur);
  window.riff.suspendHotkeys(false);
}

function finalizeRecording(combo) {
  $(recordingTarget).value = combo;
  stopRecording();
}

function onRecordKeydown(e) {
  e.preventDefault();
  if (e.code === 'Escape') { $(recordingTarget).value = recordingBefore; stopRecording(); return; }
  clearTimeout(releaseTimer); // neuer Tastendruck - ein laufendes "gleich abschliessen" verwerfen
  const mod = MOD_KEY[e.code];
  if (mod) { heldMods.add(mod); maxMods.add(mod); return; }
  const key = mainKeyName(e);
  if (!key) return; // nicht unterstuetzte Taste - Nutzer versucht's erneut
  finalizeRecording(comboOf(recordingTarget, key));
}

function onRecordKeyup(e) {
  const mod = MOD_KEY[e.code];
  if (!mod) return;
  heldMods.delete(mod);
  if (heldMods.size === 0 && maxMods.size > 0) {
    clearTimeout(releaseTimer);
    const target = recordingTarget;
    releaseTimer = setTimeout(() => {
      // Reine Modifier-Kombi ("Control+Alt") ist nur fuer die Diktat-Hotkeys
      // sinnvoll - Electrons globalShortcut braucht immer eine Haupttaste.
      if (recordingTarget && target !== 'tfAccel') finalizeRecording(comboOf(target, ''));
    }, RELEASE_GRACE_MS);
  }
}

function onRecordBlur() {
  if (recordingTarget) { $(recordingTarget).value = recordingBefore; stopRecording(); }
}

function startRecording(targetId) {
  if (recordingTarget) stopRecording();
  recordingTarget = targetId;
  recordingBefore = $(targetId).value;
  $(`rec-${targetId}`).classList.add('recording');
  window.riff.suspendHotkeys(true); // Aufnahme darf kein echtes Diktat ausloesen
  window.addEventListener('keydown', onRecordKeydown, true);
  window.addEventListener('keyup', onRecordKeyup, true);
  window.addEventListener('blur', onRecordBlur);
}

for (const btn of document.querySelectorAll('.rec-btn')) {
  btn.addEventListener('click', () => {
    if (recordingTarget === btn.dataset.target) stopRecording();
    else startRecording(btn.dataset.target);
  });
}

for (const btn of document.querySelectorAll('.reset-btn')) {
  btn.addEventListener('click', () => {
    $(btn.dataset.target).value = S.defaultHotkeys[btn.dataset.target] || '';
  });
}

// ---------- Start ----------

window.riff.onDataChanged(() => reload());
window.riff.onAccountChanged(() => reload());
window.riff.onNavigate((v) => go(v));

reload().then(() => { go('dictation'); maybeStartOnboarding(S); });
