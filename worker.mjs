// Trailhead Outfitters on Cloudflare Workers — the always-on surface
// (PAYPAL-P2-WORKER-PORT-1, plan §3). Same routes, same Phase 0-secure
// semantics and same lib/ code path as server.js (the local dev entry).
//
// Web-API runtime only: fetch, crypto.randomUUID, the D1 `DB` binding as the
// store backend, and static assets + catalog from the deploy-time generated
// ./assets.mjs module. No node builtins are imported here (and none may be —
// scripts/check-worker-bundle.mjs enforces it).
import { createPaypal } from './lib/paypal.js';
import { createLlm } from './lib/llm.js';
import { createAgent } from './lib/agent.js';
import { createStore } from './lib/store.js';
import { createMcp, MUTATING_TOOLS } from './lib/mcp.js';
import { ASSETS, CATALOG } from './assets.mjs';

const SESSION_TTL = 30 * 60 * 1000;
const SESSION_CAP = 200;
const BODY_LIMIT = 64 * 1024;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

let startedAt = null; // set on first request: global-scope Date.now() is 0 in Workers
const sessions = new Map(); // sid -> { turns, lastSeen } — per-isolate cache; the D1 store is durable
const buckets = new Map();  // token-bucket throttle, per key

// ---- session semantics mirrored from server.js (P1): turns persist through
// the store seam and hydrate lazily on first access after a miss; TTL honored ----
async function session(sid, store) {
  if (!sid) return null;
  await pruneSessions(store);
  let s = sessions.get(sid);
  if (!s) {
    const stored = await store.loadSession(sid);
    if (stored && Date.now() - stored.lastSeen <= SESSION_TTL) {
      s = { turns: stored.turns, lastSeen: stored.lastSeen };
      sessions.set(sid, s);
    } else if (stored) {
      await store.deleteSession(sid); // expired while nobody was looking
    }
  }
  if (!s) {
    s = { turns: [], lastSeen: Date.now() };
    sessions.set(sid, s);
  }
  s.lastSeen = Date.now();
  return s;
}

async function pruneSessions(store) {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.lastSeen > SESSION_TTL) {
      sessions.delete(k);
      await store.deleteSession(k);
    }
  }
  while (sessions.size > SESSION_CAP) {
    let oldest = null;
    let t = Infinity;
    for (const [k, v] of sessions) if (v.lastSeen < t) { t = v.lastSeen; oldest = k; }
    sessions.delete(oldest);
    await store.deleteSession(oldest);
  }
}

// token-bucket throttle (per session; burst 10, refill 1 per 5s) — as server.js
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

const json = (body, status = 200) => Response.json(body, { status });

// Per-isolate runtime built from the Worker bindings on first fetch; the orders
// Map hydrates from D1 exactly like server.js hydrates from the sqlite store.
let runtime = null;
async function boot(env) {
  startedAt ??= Date.now();
  if (!runtime || runtime.env !== env) {
    const store = createStore({ d1: env.DB });
    const paypal = createPaypal(env);
    const llm = createLlm(env);
    const agent = createAgent({ catalog: CATALOG, paypal, llm, store });
    await agent.hydrateOrders();
    runtime = { env, store, paypal, agent, mcp: createMcp({ agent, paypal }) };
  }
  return runtime;
}

export default {
  async fetch(request, env) {
    const rt = await boot(env);
    const url = new URL(request.url);
    const origin = url.origin;
    const sid = request.headers.get('x-session-id');
    const admin = Boolean(rt.env.MCP_TOKEN) && request.headers.get('authorization') === `Bearer ${rt.env.MCP_TOKEN}`;
    try {
      if (url.pathname === '/healthz') {
        return json({ ok: true, env: rt.paypal.env, version: '0.3.0', uptime: Math.round((Date.now() - startedAt) / 1000) });
      }
      // §0.3: mutating MCP tools require the admin bearer — front-door, fail-closed
      if (url.pathname === '/mcp' && request.method === 'POST') {
        const raw = await request.text();
        if (raw.length > BODY_LIMIT) return json({ error: 'body too large' }, 413);
        let rpc = {};
        try { rpc = JSON.parse(raw); } catch { /* malformed body: let dispatch report the parse error */ }
        if (rpc?.method === 'tools/call' && MUTATING_TOOLS.has(rpc?.params?.name) && !admin) {
          return json({
            jsonrpc: '2.0',
            id: rpc.id ?? null,
            error: { code: -32001, message: `unauthorized: ${rpc.params.name} requires Authorization: Bearer MCP_TOKEN` },
          }, 401);
        }
        const { status, payload } = await rt.mcp.dispatch(rpc, origin);
        if (payload === null) return new Response(null, { status });
        return json(payload, status);
      }

      if (url.pathname === '/api/config') {
        return json({ clientId: rt.paypal.clientId, env: rt.paypal.env, model: 'glm-5.3-flash', store: 'Trailhead Outfitters', sessionId: crypto.randomUUID() });
      }
      if (url.pathname === '/api/chat' && request.method === 'POST') {
        if (!sid) return json({ error: 'missing x-session-id header (GET /api/config first)' }, 400);
        if (!throttle(`chat:${sid}`)) return json({ error: 'slow down — too many messages, try again in a few seconds' }, 429);
        const raw = await request.text();
        if (raw.length > BODY_LIMIT) return json({ error: 'body too large' }, 413);
        const { message } = raw ? JSON.parse(raw) : {};
        if (!message?.trim()) return json({ error: 'empty message' }, 400);
        const s = await session(sid, rt.store);
        const turn = await rt.agent.agentTurn(message, s.turns, origin, sid);
        s.turns.push({ role: 'user', content: message }, { role: 'assistant', content: turn.reply });
        await rt.store.saveSession(sid, s.turns, s.lastSeen); // restart-safe chat history
        return json(turn);
      }
      if (url.pathname.startsWith('/api/capture/') && request.method === 'POST') {
        const id = url.pathname.split('/').pop();
        const rec = rt.agent.orders.get(id);
        if (!rec) return json({ error: `order ${id} not found` }, 404);
        if (!admin && (!sid || rec.sid !== sid)) return json({ error: 'this order belongs to another session' }, 403);
        const out = await rt.paypal.captureOrder(id);
        rec.status = out.status;
        rec.captureId = out.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null;
        // write-through (P1): a captured order must survive a restart
        await rt.store.saveOrder(id, rec);
        if (rec.captureId) {
          await rt.store.saveCapture({ capture_id: rec.captureId, order_id: id, amount: rec.amount, status: out.status, created_at: new Date().toISOString() });
        }
        return json({ status: out.status, captureId: rec.captureId, orderId: id });
      }
      if (url.pathname === '/api/orders') {
        const list = [...rt.agent.orders.entries()]
          .filter(([, o]) => (admin ? true : o.sid && o.sid === sid))
          .map(([id, o], i) => ({ n: i + 1, order_id: id, ...o }));
        return json({ orders: list });
      }

      // static assets, inlined at deploy time (deploy/deploy-worker.mjs)
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (Object.prototype.hasOwnProperty.call(ASSETS, file)) {
        const ext = file.slice(file.lastIndexOf('.'));
        return new Response(ASSETS[file], { headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' } });
      }
      return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    } catch (e) {
      return json({ error: e?.message || String(e) }, e?.status || 500);
    }
  },
};
