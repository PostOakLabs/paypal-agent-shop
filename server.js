// Trailhead Outfitters — zero-dependency server: static UI + agent + PayPal sandbox APIs.
// Phase 0-secure: per-session chat history, session-bound captures, bearer-gated MCP
// mutations, throttle + body caps. Nothing here may be publicly exposed without these.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { paypal } from './lib/paypal.js';
import { agentTurn, orders } from './lib/agent.js';
import { handleMcp } from './lib/mcp.js';

const PUBLIC = new URL('./public', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
const BODY_LIMIT = 64 * 1024;

const env = Object.fromEntries(
  readFileSync(new URL('./.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    .filter(([, v]) => v !== '')
);
const MCP_TOKEN = env.MCP_TOKEN || '';

// ---- per-session chat state (replaces the process-global history array) ----
const SESSION_TTL = 30 * 60 * 1000;
const SESSION_CAP = 200;
const sessions = new Map(); // sid -> { turns: [], lastSeen }

function session(sid) {
  if (!sid) return null;
  pruneSessions();
  let s = sessions.get(sid);
  if (!s) {
    s = { turns: [], lastSeen: Date.now() };
    sessions.set(sid, s);
  }
  s.lastSeen = Date.now();
  return s;
}

function pruneSessions() {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.lastSeen > SESSION_TTL) sessions.delete(k);
  while (sessions.size > SESSION_CAP) {
    let oldest = null;
    let t = Infinity;
    for (const [k, v] of sessions) if (v.lastSeen < t) { t = v.lastSeen; oldest = k; }
    sessions.delete(oldest);
  }
}

// ---- token-bucket throttle (per session; burst 10, refill 1 per 5s) ----
const buckets = new Map();
function throttle(key) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: 10, last: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(10, b.tokens + (now - b.last) / 5000);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

const isAdmin = (req) => Boolean(MCP_TOKEN) && req.headers.authorization === `Bearer ${MCP_TOKEN}`;

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > BODY_LIMIT) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const origin = `${url.protocol}//${url.host}`;
  const sid = req.headers['x-session-id'] || null;
  try {
    if (url.pathname === '/healthz') {
      return json(res, 200, { ok: true, env: paypal.env, version: '0.2.0', uptime: Math.round(process.uptime()) });
    }
    if (url.pathname === '/mcp' && req.method === 'POST') return handleMcp(req, res, origin, { admin: isAdmin(req) });

    if (url.pathname === '/api/config') {
      return json(res, 200, { clientId: paypal.clientId, env: paypal.env, model: 'glm-5.3-flash', store: 'Trailhead Outfitters', sessionId: randomUUID() });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      if (!sid) return json(res, 400, { error: 'missing x-session-id header (GET /api/config first)' });
      if (!throttle(`chat:${sid}`)) return json(res, 429, { error: 'slow down — too many messages, try again in a few seconds' });
      const { message } = await readBody(req);
      if (!message?.trim()) return json(res, 400, { error: 'empty message' });
      const s = session(sid);
      const turn = await agentTurn(message, s.turns, origin, sid);
      s.turns.push({ role: 'user', content: message }, { role: 'assistant', content: turn.reply });
      return json(res, 200, turn);
    }
    if (url.pathname.startsWith('/api/capture/') && req.method === 'POST') {
      const id = url.pathname.split('/').pop();
      const rec = orders.get(id);
      if (!rec) return json(res, 404, { error: `order ${id} not found` });
      if (!isAdmin(req) && (!sid || rec.sid !== sid)) return json(res, 403, { error: 'this order belongs to another session' });
      const out = await paypal.captureOrder(id);
      rec.status = out.status;
      rec.captureId = out.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null;
      return json(res, 200, { status: out.status, captureId: rec.captureId, orderId: id });
    }
    if (url.pathname === '/api/orders') {
      const list = [...orders.entries()]
        .filter(([, o]) => (isAdmin(req) ? true : o.sid && o.sid === sid))
        .map(([id, o], i) => ({ n: i + 1, order_id: id, ...o }));
      return json(res, 200, { orders: list });
    }

    // static files
    let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const path = join(PUBLIC, file);
    if (existsSync(path) && !path.endsWith('/')) {
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
      return res.end(readFileSync(path));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
});

const port = Number(process.env.PORT || 8788);
server.listen(port, () => console.log(`Trailhead Outfitters ready: http://localhost:${port}`));
