// EIN Chat-Completion-Pfad für alles, was in Riff ein Sprachmodell braucht:
// Transkript-Cleanup (voice/transcriptCleanup.js) und Transforms
// (transforms.js). Vorher lebte diese Logik nur im Cleanup - bei zwei
// Aufrufern wäre sie zweimal dagestanden, inklusive zweier Stellen, an denen
// der n8n-Fallback vergessen werden kann.
//
// Zwei Routen, identischer Vertrag (DECISIONS.md D5):
//   - eigener OpenRouter-Key in config.json -> direkter Call, minimale Latenz
//   - kein Key -> Riffs n8n-Webhook, der einen hinterlegten Key nutzt
//     (Wispr-Flow-Prinzip: der Nutzer braucht nie einen eigenen Key)
const N8N_CHAT_URL = 'https://n8n.halovisionai.cloud/webhook/sable-chat';

async function viaOpenRouter(cfg, messages, opts) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.voice.openRouterApiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(opts.timeoutMs),
    body: JSON.stringify({
      model: opts.model || cfg.voice.cleanupModel,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      // Wirkt nur, wenn das Modell auch bei Groq liegt - ohne
      // allow_fallbacks:false routet OpenRouter sonst einfach zum eigentlichen
      // Anbieter. Kein Hard-Fail durchs Pinning möglich.
      provider: { order: ['groq'] },
      messages,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, text: '', error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  }
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  return text ? { ok: true, text, error: null } : { ok: false, text: '', error: 'EMPTY_RESPONSE' };
}

async function viaN8n(messages, opts) {
  const res = await fetch(N8N_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs * 2.5), // n8n ist ein Hop mehr
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) return { ok: false, text: '', error: `HTTP ${res.status}` };
  const data = await res.json();
  const text = (data.text || '').trim();
  if (!data.ok || !text) return { ok: false, text: '', error: data.error || 'EMPTY_RESPONSE' };
  return { ok: true, text, error: null };
}

// Wirft nie - jeder Aufrufer bekommt { ok, text, error } und entscheidet
// selbst, was ein Fehlschlag bedeutet (Cleanup: Rohtext behalten, Transform:
// Original stehen lassen).
async function chat(cfg, { system, user, temperature = 0.3, maxTokens = 1024, timeoutMs = 6000, model } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  try {
    return cfg.voice.openRouterApiKey
      ? await viaOpenRouter(cfg, messages, { temperature, maxTokens, timeoutMs, model })
      : await viaN8n(messages, { temperature, maxTokens, timeoutMs, model });
  } catch (err) {
    return { ok: false, text: '', error: err.message || 'NETWORK_ERROR' };
  }
}

module.exports = { chat };
