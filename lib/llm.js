// Z.ai GLM via the OpenAI-compatible chat-completions wire format.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    .filter(([, v]) => v !== '')
);

if (!env.LLM_API_KEY) throw new Error('LLM_API_KEY missing in .env');

export const llm = {
  model: env.LLM_MODEL || 'glm-5.3-flash',
  baseUrl: env.LLM_BASE_URL || 'https://api.z.ai/api/coding/paas/v4',
  key: env.LLM_API_KEY,
  // thinking disabled by default: ~5x faster turns, tool calls unaffected (verified)
  chat: (messages, tools, { maxTokens = 2048, thinking = 'disabled' } = {}) =>
    fetch(`${env.LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.LLM_MODEL || 'glm-5.3-flash', messages, tools, max_tokens: maxTokens, stream: false, thinking: { type: thinking } }),
    }).then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(`llm ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
      return body.choices[0].message;
    }),
};
