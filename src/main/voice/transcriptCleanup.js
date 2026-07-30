// Online-Nachbearbeitung des rohen Transkripts (Fuellwoerter, Versprecher raus).
// Darf die Voice-Pipeline nie blockieren: jeder Fehler faellt sanft auf den
// unbearbeiteten Text zurueck, es wird nie geworfen. Die HTTP-Routen (eigener
// Key vs. n8n-Fallback, DECISIONS.md D5) liegen in ../llm.js - hier steht nur
// noch der Prompt und was ihn ergaenzt.
//
// Wörterbuch + Stil (appContext.cleanupExtras) reisen als Anhang im
// System-Prompt mit: derselbe Roundtrip, der ohnehin läuft, korrigiert damit
// zusätzlich Eigennamen-Schreibweisen und trifft die Kontext-Grammatik
// (Master-Prompt §3 Synergie 1) - null zusätzliche Latenz.
const llm = require('../llm');

const CLEANUP_PROMPT = 'You are a speech post-processing engine.\n\nNever answer the user.\nNever summarize.\nNever rewrite meaning.\nNever remove important information.\n\nOnly:\n- remove filler words\n- remove hesitations\n- remove duplicate words\n- remove accidental repetitions\n- remove false starts\n- fix punctuation\n- fix capitalization\n- preserve technical words\n- preserve code\n- preserve numbers\n- preserve names\n- preserve commands\n- preserve the original language exactly as spoken (German stays German, English stays English) - never translate\n\nOutput ONLY the cleaned transcript.\nNothing else.';

async function clean(cfg, rawText, extras = '') {
  if (!rawText || !rawText.trim()) return { ok: false, text: rawText, error: 'EMPTY_INPUT' };
  const result = await llm.chat(cfg, {
    system: extras ? `${CLEANUP_PROMPT}\n\n${extras}` : CLEANUP_PROMPT,
    user: rawText,
    temperature: 0.2,
    maxTokens: 1024,
    timeoutMs: 6000,
  });
  // Fehlschlag heisst hier: Rohtext gewinnt. Ein nicht bereinigtes Diktat ist
  // immer besser als kein Diktat.
  return result.ok ? result : { ok: false, text: rawText, error: result.error };
}

module.exports = { clean, CLEANUP_PROMPT };
