// Konto: Registrieren/Anmelden/Passwort-Reset gegen den geteilten n8n-Auth-
// Workflow "Accounts — Auth" (ein Google Sheet, eine Tab pro App - Guardian
// und Riff teilen sich dieselbe Infrastruktur und dasselbe Sicherheitsdesign
// wie PAIDEIAs Auth-Workflow: SHA256+iteriertes Hashing, Rate-Limits pro IP,
// Lockout pro E-Mail nach 8 Fehlversuchen, anti-enumeration Passwort-Reset).
// Ein einziger Action-Webhook statt vier REST-Routen, siehe
// n8n "Accounts — Auth (Guardian + Riff, Signup/Login/Reset/Verify)".
//
// Bewusste Grenzen (Master-Prompt §2 C16 / §3 Synergie 4):
//   - Anmelden ist NIE Voraussetzung fuers Diktieren. Ohne Konto laeuft alles
//     lokal weiter, nur eben ohne Namen.
//   - Die Pro-Freischaltung per Code (license.js, D4) bleibt komplett
//     unangetastet - der Auth-Workflow kennt gar kein Tier-Feld, ein Konto
//     aendert also nie, ob dieses Geraet Pro ist oder nicht.
//   - Das Session-Token bleibt im Main-Prozess/config.json - der Renderer
//     bekommt nur E-Mail/Name zu sehen.
const config = require('./config');

const TIMEOUT_MS = 10000;
const ACCOUNTS_API = process.env.ACCOUNTS_API_URL || 'https://n8n.halovisionai.cloud/webhook/accounts-auth';
const APP = 'riff';

function state(cfg) {
  return {
    signedIn: Boolean(cfg.account.token),
    email: cfg.account.email || '',
    name: cfg.account.name || '',
    tier: cfg.account.tier,
    hasLocalCode: Boolean(cfg.account.licenseCode),
  };
}

async function call(action, body) {
  let res;
  try {
    res = await fetch(ACCOUNTS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: APP, action, ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reply: 'Server nicht erreichbar. / Server unreachable.' };
  }
  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, reply: 'Unerwartete Serverantwort. / Unexpected server response.' };
  return data;
}

// Tier bleibt IMMER lokal/code-gesteuert (license.js) - der Auth-Workflow
// hat kein Tier-Konzept, ein Login darf ein per Code freigeschaltetes Pro
// nie beeinflussen, weder rauf noch runter.
function persist(cfg, { email, name, token }) {
  config.saveConfig({ account: { email, name: name || '', token } });
  cfg.account.email = email;
  cfg.account.name = name || '';
  cfg.account.token = token;
}

async function signup(cfg, { email, password, name }) {
  const res = await call('signup', { email, password, name });
  if (res.ok) persist(cfg, res);
  return res.ok ? { ok: true, account: state(cfg) } : res;
}

async function login(cfg, { email, password }) {
  const res = await call('login', { email, password });
  if (res.ok) persist(cfg, res);
  return res.ok ? { ok: true, account: state(cfg) } : res;
}

// Generische Antwort ist Absicht (anti-enumeration, siehe Auth-Workflow) -
// ob die E-Mail existiert, wird nie verraten. "ok" bedeutet hier nur
// "Anfrage angenommen", nicht "E-Mail gefunden".
async function requestReset(cfg, { email }) {
  return call('request_reset', { email });
}

async function confirmReset(cfg, { email, code, newPassword }) {
  const res = await call('confirm_reset', { email, code, newPassword });
  if (res.ok) persist(cfg, res);
  return res.ok ? { ok: true, account: state(cfg) } : res;
}

function logout(cfg) {
  // Token nur lokal verwerfen: der Serverseite ist eine verwaiste Session
  // egal (sie laeuft ohnehin ab), und ein Logout darf nicht am Netz haengen.
  config.saveConfig({ account: { email: '', name: '', token: '' } });
  cfg.account.email = '';
  cfg.account.name = '';
  cfg.account.token = '';
  return { ok: true, account: state(cfg) };
}

// Beim Start still nachziehen: ist die Session noch gueltig? Fehler/offline
// werden geschluckt - das ist kein Grund, den Nutzer lokal abzumelden. Nur
// ein explizites "Sitzung abgelaufen" vom Server loggt wirklich aus.
async function refresh(cfg) {
  if (!cfg.account.token) return state(cfg);
  const res = await call('verify', { token: cfg.account.token });
  if (res.ok) persist(cfg, { email: res.email, name: res.name, token: cfg.account.token });
  else if (res.reply && /Sitzung abgelaufen|Session expired/.test(res.reply)) logout(cfg);
  return state(cfg);
}

module.exports = { state, signup, login, logout, refresh, requestReset, confirmReset };
