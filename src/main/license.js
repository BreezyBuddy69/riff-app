// Konto/Kontingent: Free-Tier zaehlt Woerter gegen WEEKLY_LIMIT, Pro (per
// Code-Einloesung auf websites/riff) ist unbegrenzt (Nutzer-Feedback
// 2026-07-29, Master-Prompt §6.10/§9). Redemption-Vertrag ist identisch zu
// websites/riff/server/index.js' /api/redeem (Sable-Fork, siehe DECISIONS.md
// D4) - ein Code schaltet EINMALIG und PERMANENT frei, kein Abo/Ablauf.
const config = require('./config');

const WEEKLY_LIMIT = 1500;
const API_BASE = process.env.RIFF_API_BASE || 'https://halovisionai.cloud/riff';

// Montag 00:00 UTC der Woche, die `ts` enthaelt - Kalenderwoche statt
// rollierendem 7-Tage-Fenster, einfacher zu erklaeren ("Montags neu").
function mondayOf(ts) {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7; // 0 = Montag
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Rollt die Woche still weiter, sobald seit dem gespeicherten weekStart eine
// neue Kalenderwoche begonnen hat. Muss bei JEDEM Zugriff laufen (nicht nur
// beim Diktieren), sonst zeigt Settings in einer Woche ganz ohne Diktat noch
// die Zahlen der Vorwoche an.
function currentQuota(cfg) {
  const thisMonday = mondayOf(Date.now());
  if (cfg.quota.weekStart !== thisMonday) {
    config.saveConfig({ quota: { weekStart: thisMonday, wordsUsed: 0 } });
    cfg.quota.weekStart = thisMonday;
    cfg.quota.wordsUsed = 0;
  }
  return cfg.quota;
}

function isPro(cfg) { return cfg.account.tier === 'pro'; }

function canDictate(cfg) {
  return isPro(cfg) || currentQuota(cfg).wordsUsed < WEEKLY_LIMIT;
}

function recordWords(cfg, text) {
  if (isPro(cfg)) return;
  const n = (String(text || '').match(/\S+/g) || []).length;
  if (!n) return;
  const quota = currentQuota(cfg);
  const wordsUsed = quota.wordsUsed + n;
  config.saveConfig({ quota: { wordsUsed } });
  cfg.quota.wordsUsed = wordsUsed;
}

async function redeem(cfg, code) {
  const trimmed = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!trimmed) return { ok: false, reason: 'invalid_format' };

  let res;
  try {
    // 'riff-pro' statt 'riff': eigener Code-Pool fuer die Pro-Freischaltung,
    // getrennt vom Zugangscode, der auf der Website den Download freischaltet
    // (Nutzerwunsch 2026-07-29 - zwei unabhaengige Codes statt einem, der
    // beides gleichzeitig sein sollte und sich nach der Website-Einloesung
    // nicht mehr in der App einloesen liess).
    res = await fetch(`${API_BASE}/api/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: 'riff-pro', code: trimmed }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    return { ok: false, reason: 'server_error' };
  }

  const data = await res.json().catch(() => null);
  if (data && data.ok) {
    config.saveConfig({ account: { tier: 'pro', licenseCode: trimmed } });
    cfg.account.tier = 'pro';
    cfg.account.licenseCode = trimmed;
    return { ok: true };
  }

  // "already_redeemed" bei GENAU dem Code, den wir selbst schon lokal
  // gespeichert haben, ist kein Fehler - Normalfall nach Reinstall, wenn
  // config.json verloren ging, der Code beim Server aber laengst als von uns
  // verbraucht gilt. Alles andere (fremder/ungueltiger Code) bleibt ein
  // echter Fehler.
  if (data && data.reason === 'already_redeemed' && cfg.account.licenseCode === trimmed) {
    config.saveConfig({ account: { tier: 'pro' } });
    cfg.account.tier = 'pro';
    return { ok: true };
  }

  return { ok: false, reason: (data && data.reason) || 'server_error' };
}

module.exports = { WEEKLY_LIMIT, API_BASE, currentQuota, isPro, canDictate, recordWords, redeem };
