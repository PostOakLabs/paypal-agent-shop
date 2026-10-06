#!/usr/bin/env node
// Trailhead Phase-0-secure permanent smoke (§0.5). Zero dependencies: node builtins only.
//
//   node scripts/smoke.mjs local   hermetic: boots the server on an ephemeral port with
//                                  a throwaway bearer token and seeded in-memory orders —
//                                  NO LLM spend, NO PayPal calls
//   node scripts/smoke.mjs chat    OPT-IN: one live agent turn against the real .env
//                                  (LLM + a PayPal SANDBOX order, never approved/captured) —
//                                  asserts the chat create_order -> order_created event
//                                  path whose breakage was the P0 button regression
//
// Exit 0 green / 1 red / 2 usage.
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const mode = process.argv[2] || 'local';
if (mode !== 'local' && mode !== 'chat') {
  console.error('usage: node scripts/smoke.mjs [local|chat]');
  process.exit(2);
}

const TEST_TOKEN = `smoke-${randomUUID()}`;
process.env.MCP_TOKEN = TEST_TOKEN; // server.js prefers process env: no .env mutation
process.env.PORT = '0';             // ephemeral port

const { server } = await import('../server.js');
const { orders } = await import('../lib/agent.js');

await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const ok = (cond, label) => {
  if (cond) { console.log(`  ok  ${label}`); passed++; return; }
  throw new Error(label);
};

const call = (path, { method = 'GET', body, sid, bearer } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(sid ? { 'x-session-id': sid } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

const mcp = (method, params, bearer) =>
  call('/mcp', { method: 'POST', bearer, body: { jsonrpc: '2.0', id: 1, method, params } });

async function finish(code) {
  console.log(code === 0 ? `SMOKE ${mode} GREEN: ${passed} assertions passed` : `SMOKE ${mode} RED`);
  server.closeAllConnections?.();
  await new Promise((res) => server.close(res));
  // let the loop drain and exit naturally — an immediate process.exit() here races
  // libuv async teardown on win32 (src\win\async.c assertion, measured 2026-10-06);
  // the unref'd timer only fires if a stray handle keeps the loop alive.
  const kill = setTimeout(() => process.exit(code), 250);
  kill.unref();
}

async function local() {
  // /healthz (§0.4)
  {
    const r = await call('/healthz');
    const b = await r.json();
    ok(r.status === 200 && b.ok === true, '/healthz -> 200 {ok:true}');
    ok(typeof b.env === 'string' && typeof b.version === 'string' && typeof b.uptime === 'number', '/healthz carries env/version/uptime');
  }

  // /api/config issues a fresh opaque session id per call (§0.2)
  {
    const c1 = await (await call('/api/config')).json();
    const c2 = await (await call('/api/config')).json();
    ok(!!c1.sessionId && !!c2.sessionId && c1.sessionId !== c2.sessionId, '/api/config issues two distinct session ids');
  }

  // MCP read-only surface stays open (§0.3)
  {
    const r = await mcp('tools/list');
    const b = await r.json();
    const names = (b.result?.tools || []).map((t) => t.name);
    ok(r.status === 200 && names.length === 4 && names.includes('trailhead_create_order') && names.includes('trailhead_refund_order'), '/mcp tools/list open without bearer (4 tools)');
  }

  // MCP mutating tools are bearer-gated, fail-closed (§0.3)
  {
    const r = await mcp('tools/call', { name: 'trailhead_create_order', arguments: { item_id: 'sku-002', quantity: 1 } });
    const b = await r.json();
    ok(r.status === 401 && b.error?.code === -32001, 'MCP trailhead_create_order refused without bearer (401)');
  }
  {
    const r = await mcp('tools/call', { name: 'trailhead_refund_order', arguments: { order_id: 'SMOKE-1' } }, 'wrong-token');
    ok(r.status === 401, 'MCP trailhead_refund_order refused with a wrong bearer (401)');
  }
  {
    // authorized bearer passes the gate and reaches the tool layer — hermetic: an
    // unknown order fails in-memory before any PayPal call
    const r = await mcp('tools/call', { name: 'trailhead_refund_order', arguments: { order_id: 'SMOKE-NONE' } }, TEST_TOKEN);
    const b = await r.json();
    ok(r.status === 200 && b.result?.isError === true && String(b.result.content?.[0]?.text).includes('no captured payment stored'), 'MCP mutating call with the admin bearer passes the gate (reaches the tool layer)');
  }

  // session-bound captures + /api/orders scoping (§0.3) — seeded order, no PayPal spend
  {
    const sidA = randomUUID();
    const sidB = randomUUID();
    orders.set('SMOKE-1', { item: 'Smoke Test Gear', qty: 1, amount: 1, status: 'CREATED', captureId: null, sid: sidA, createdAt: new Date().toISOString() });
    const foreign = await call('/api/capture/SMOKE-1', { method: 'POST', sid: sidB });
    ok(foreign.status === 403 && (await foreign.json()).error.includes('another session'), 'cross-session capture refused with 403');
    const anon = await call('/api/capture/SMOKE-1', { method: 'POST' });
    ok(anon.status === 403, 'capture without any session refused with 403');
    ok(orders.get('SMOKE-1').status === 'CREATED' && orders.get('SMOKE-1').captureId === null, 'refused captures never reached PayPal (order still CREATED, no capture id)');
    const unknown = await call('/api/capture/SMOKE-NONE', { method: 'POST', sid: sidA });
    ok(unknown.status === 404, 'capture of an unknown order -> 404 (before any PayPal call)');
    const own = await call('/api/orders', { sid: sidA });
    const ownList = (await own.json()).orders;
    const otherList = (await (await call('/api/orders', { sid: sidB })).json()).orders;
    const anonList = (await (await call('/api/orders')).json()).orders;
    const adminList = (await (await call('/api/orders', { bearer: TEST_TOKEN })).json()).orders;
    ok(own.status === 200 && ownList.length === 1 && ownList[0].order_id === 'SMOKE-1', '/api/orders shows the session its own order');
    ok(otherList.length === 0 && anonList.length === 0, '/api/orders hides the order from other and absent sessions');
    ok(adminList.some((o) => o.order_id === 'SMOKE-1'), '/api/orders admin bearer override sees it');
    orders.delete('SMOKE-1');
  }

  // chat guards (§0.4): session required, 64 KiB cap, token-bucket — all before LLM spend
  {
    const noSid = await call('/api/chat', { method: 'POST', body: { message: 'hi' } });
    ok(noSid.status === 400, 'POST /api/chat without x-session-id -> 400');
    const big = await call('/api/chat', { method: 'POST', sid: randomUUID(), body: 'x'.repeat(65 * 1024 + 1) });
    ok(big.status === 413, 'oversized chat body (>64 KiB) -> 413');
    const sid = randomUUID();
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await call('/api/chat', { method: 'POST', sid, body: { message: '' } })).status);
    ok(statuses.slice(0, 10).every((s) => s === 400), `throttle: the 10-token burst passes, empty message -> 400 (${statuses.slice(0, 10).join(',')})`);
    ok(statuses[10] === 429 && statuses[11] === 429, `throttle: requests 11-12 -> 429 (${statuses[10]},${statuses[11]})`);
    ok(statuses.every((s) => s !== 200), 'no request reached the LLM (a 200 would mean agentTurn ran)');
  }
}

async function chat() {
  const { sessionId } = await (await call('/api/config')).json();
  const t0 = Date.now();
  const r = await call('/api/chat', {
    method: 'POST',
    sid: sessionId,
    body: { message: 'Please create an order for one sku-002, the Scree 2P Backpacking Tent.' },
  });
  const turn = await r.json();
  ok(r.status === 200, `live chat turn -> 200 (${Date.now() - t0}ms)`);
  ok(turn.events?.[0]?.type === 'order_created', 'chat create_order path emits events[0].type === "order_created" (the P0 regression catcher)');
  ok(typeof turn.events?.[0]?.order_id === 'string' && turn.events[0].order_id.length >= 5, `order_id present: ${turn.events?.[0]?.order_id}`);
  ok(typeof turn.reply === 'string' && turn.reply.length > 0, `Avo replied: "${String(turn.reply).slice(0, 80)}"`);
  console.log('  note: chat mode left a SANDBOX order unapproved (never captured) — that is the documented opt-in cost');
}

try {
  if (mode === 'local') await local();
  else await chat();
  await finish(0);
} catch (e) {
  console.error(`RED: ${e.message}`);
  await finish(1);
}
