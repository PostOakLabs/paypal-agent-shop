// Z.ai GLM via the OpenAI-compatible chat-completions wire format.
// createLlm(config) is the config-injection seam (P2): the Node server passes
// .env values, worker.mjs passes Worker bindings — one code path for both.
// The `llm` singleton preserves the node-path behavior (read .env once); the
// read is guarded + dynamic because the Worker graph imports this module too.
function parseEnvFile(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
      .filter(([, v]) => v !== '')
  );
}

export function createLlm(config = {}) {
  // abuse guard: clamp per-turn token spend (env override, hard ceiling 4096)
  const MAX_TOKENS_CAP = Math.min(Number(config.LLM_MAX_TOKENS) || 2048, 4096);
  return {
    model: config.LLM_MODEL || 'glm-5.3-flash',
    baseUrl: config.LLM_BASE_URL || 'https://api.z.ai/api/coding/paas/v4',
    key: config.LLM_API_KEY,
    // thinking disabled by default: ~5x faster turns, tool calls unaffected (verified)
    // (the key check lives here, not at construction: the Worker graph imports
    // this module before bindings exist — CF's upload validation executes
    // top-level code, so a module-load throw would fail every deploy)
    chat: (messages, tools, { maxTokens = 2048, thinking = 'disabled' } = {}) => {
      if (!config.LLM_API_KEY) throw new Error('LLM_API_KEY missing (config / .env / Worker binding)');
      return fetch(`${config.LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.LLM_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.LLM_MODEL || 'glm-5.3-flash', messages, tools, max_tokens: Math.min(maxTokens, MAX_TOKENS_CAP), stream: false, thinking: { type: thinking } }),
      }).then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(`llm ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
        return body.choices[0].message;
      });
    },
  };
}

// node-path singleton (the fs read only runs in a Node process; the Worker
// graph never touches it)
let fileEnv = {};
if (typeof process !== 'undefined' && process.versions?.node) {
  try {
    const { readFileSync } = await import('node:fs');
    fileEnv = parseEnvFile(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
  } catch { /* no .env readable: singleton stays unconfigured (factories are the real path) */ }
}

export const llm = createLlm(fileEnv);
