// Unit gate for the PayPal Add Tracking client (PAYPAL-E1-TRACKING-1).
//
// Checks, on lib/tracking.js:
//   1. buildTrackersBody produces the exact POST /v1/shipping/trackers body:
//      a trackers[] of one entry carrying transaction_id (the capture id),
//      tracking_number, carrier, and status — default 'SHIPPED' — and rejects
//      empty fields / unknown statuses.
//   2. sendTracking POSTs to /v1/shipping/trackers with `Authorization: Bearer
//      <token>` and the JSON body intact, and surfaces non-ok responses.
//   3. Mutation proof: four tampered scratch copies (endpoint path changed,
//      Bearer scheme dropped, transaction_id field dropped, default status
//      flipped) MUST each be caught by these checks — if any tamper passes, the
//      gate itself is broken and we exit 1.
// Exit 0 green / 1 red. Zero-dependency (node: builtins only). Needs .env
// (copy .env.example) because lib/paypal.js reads it at import time — the
// module under test reuses that token path by design.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const libDir = dirname(fileURLToPath(new URL('../lib/tracking.js', import.meta.url)));

// --- fetch stub, installed BEFORE any import of the module under test --------
const calls = [];
const OK_RESPONSE = {
  ok: true,
  status: 201,
  json: async () => ({ tracker_identifiers: [{ tracker_id: 'UNITTEST', status: 'SHIPPED' }] }),
};
let responder = OK_RESPONSE;
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  return responder;
};

// --- the check suite ----------------------------------------------------------
// Runs every shape/request assertion against a module. Returns a list of
// failure strings (empty = module passes).
async function runChecks(mod) {
  const bad = [];
  const check = (name, cond, detail = '') => {
    if (!cond) bad.push(`${name}${detail ? ` (${detail})` : ''}`);
  };
  const guard = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      bad.push(`${name} threw: ${e.message}`);
    }
  };

  check('buildTrackersBody is exported as a function', typeof mod.buildTrackersBody === 'function');
  check('sendTracking is exported as a function', typeof mod.sendTracking === 'function');
  if (typeof mod.buildTrackersBody !== 'function' || typeof mod.sendTracking !== 'function') return bad;

  let body;
  await guard('buildTrackersBody happy path', async () => {
    body = mod.buildTrackersBody({ captureId: '8XA123456B1234560', trackingNumber: '1Z999AA10123456784', carrier: 'UPS' });
    check('body.trackers is an array', Array.isArray(body?.trackers), JSON.stringify(body));
    check('body.trackers has exactly one entry', body?.trackers?.length === 1);
    const t = body?.trackers?.[0] ?? {};
    check('trackers[0].transaction_id carries the capture id', t.transaction_id === '8XA123456B1234560', JSON.stringify(t.transaction_id));
    check('trackers[0].tracking_number present', t.tracking_number === '1Z999AA10123456784');
    check('trackers[0].carrier present', t.carrier === 'UPS');
    check('trackers[0].status defaults to SHIPPED', t.status === 'SHIPPED', JSON.stringify(t.status));
  });
  await guard('buildTrackersBody status override', async () => {
    const d = mod.buildTrackersBody({ captureId: '8XA123456B1234560', trackingNumber: '1Z999AA10123456784', carrier: 'UPS', status: 'DELIVERED' });
    check('trackers[0].status override honoured', d?.trackers?.[0]?.status === 'DELIVERED');
  });
  await guard('buildTrackersBody rejects empty captureId', async () => {
    let threw = false;
    try {
      mod.buildTrackersBody({ captureId: '', trackingNumber: '1Z999AA10123456784', carrier: 'UPS' });
    } catch {
      threw = true;
    }
    check('empty captureId rejected', threw);
  });
  await guard('buildTrackersBody rejects missing carrier', async () => {
    let threw = false;
    try {
      mod.buildTrackersBody({ captureId: '8XA123456B1234560', trackingNumber: '1Z999AA10123456784' });
    } catch {
      threw = true;
    }
    check('missing carrier rejected', threw);
  });
  await guard('buildTrackersBody rejects unknown status', async () => {
    let threw = false;
    try {
      mod.buildTrackersBody({ captureId: '8XA123456B1234560', trackingNumber: '1Z999AA10123456784', carrier: 'UPS', status: 'PENDING' });
    } catch {
      threw = true;
    }
    check('unknown status PENDING rejected', threw);
  });

  calls.length = 0;
  responder = OK_RESPONSE;
  await guard('sendTracking request shape', async () => {
    await mod.sendTracking('tok-abc123', body);
    check('sendTracking issued exactly one request', calls.length === 1, String(calls.length));
    const c = calls[0];
    if (!c) return;
    check('sendTracking targets /v1/shipping/trackers', c.url.endsWith('/v1/shipping/trackers'), c.url);
    check('sendTracking uses POST', c.opts?.method === 'POST', String(c.opts?.method));
    check('sendTracking sends a Bearer Authorization header', c.opts?.headers?.Authorization === 'Bearer tok-abc123', JSON.stringify(c.opts?.headers?.Authorization));
    let sent;
    try {
      sent = JSON.parse(c.opts?.body);
    } catch {
      check('sendTracking body is valid JSON', false, String(c.opts?.body));
      return;
    }
    check('sent body.trackers is a one-entry array', Array.isArray(sent?.trackers) && sent.trackers.length === 1);
    const t = sent?.trackers?.[0] ?? {};
    check('sent transaction_id carries the capture id', t.transaction_id === '8XA123456B1234560', JSON.stringify(t.transaction_id));
    check('sent tracking_number present', t.tracking_number === '1Z999AA10123456784');
    check('sent carrier present', t.carrier === 'UPS');
    check('sent status SHIPPED', t.status === 'SHIPPED');
  });
  await guard('sendTracking surfaces non-ok responses', async () => {
    calls.length = 0;
    responder = { ok: false, status: 422, json: async () => ({ name: 'UNPROCESSABLE_ENTITY' }) };
    let threw = false;
    try {
      await mod.sendTracking('tok-abc123', body);
    } catch (e) {
      threw = e.message.includes('422');
    }
    responder = OK_RESPONSE;
    check('non-ok PayPal response throws with the status', threw);
  });
  return bad;
}

const die = (msg) => {
  console.error(`RED: ${msg}`);
  process.exit(1);
};

// --- 1. the real module must pass every check ---------------------------------
const trackingUrl = pathToFileURL(join(libDir, 'tracking.js')).href;
let real;
try {
  real = await import(trackingUrl);
} catch (e) {
  die(`cannot import lib/tracking.js (${e.message}). lib/paypal.js reads ../.env at import time — copy .env.example to .env.`);
}
const realBad = await runChecks(real);
if (realBad.length > 0) {
  console.error(`RED: lib/tracking.js failed ${realBad.length} shape/request check(s):`);
  for (const b of realBad) console.error(`  - ${b}`);
  process.exit(1);
}
console.log('ok  lib/tracking.js passes all shape/request checks (body, default status, rejections, /v1/shipping/trackers + Bearer POST, non-ok surfaced)');

// --- 2. mutation proof: every tamper MUST be caught ---------------------------
const TMPERS = [
  { id: 'path', needle: "'/v1/shipping/trackers'", replacement: "'/v1/shipping/nope'", why: 'endpoint path changed' },
  { id: 'bearer', needle: 'Bearer ${accessToken}', replacement: '${accessToken}', why: 'Bearer scheme dropped' },
  { id: 'field', needle: 'transaction_id: captureId,', replacement: '', why: 'transaction_id field dropped' },
  { id: 'status', needle: "status = 'SHIPPED'", replacement: "status = 'PENDING'", why: 'default status flipped' },
];

const scratch = mkdtempSync(join(tmpdir(), 'tracking-shape-gate-'));
try {
  const scratchLib = join(scratch, 'lib');
  mkdirSync(scratchLib, { recursive: true });
  copyFileSync(join(libDir, 'paypal.js'), join(scratchLib, 'paypal.js'));
  writeFileSync(
    join(scratch, '.env'),
    ['PAYPAL_CLIENT_ID=stub-id', 'PAYPAL_CLIENT_SECRET=stub-secret', 'PAYPAL_API_BASE=https://api-m.sandbox.paypal.com', ''].join('\n')
  );

  const realSrc = readFileSync(join(libDir, 'tracking.js'), 'utf8');
  for (const t of TMPERS) {
    if (!realSrc.includes(t.needle)) die(`mutation needle for "${t.id}" not found in lib/tracking.js — the gate no longer knows this source (${t.needle}).`);
    writeFileSync(join(scratchLib, `tracking-${t.id}.js`), realSrc.replace(t.needle, t.replacement));
    let tampered;
    try {
      tampered = await import(pathToFileURL(join(scratchLib, `tracking-${t.id}.js`)).href);
    } catch (e) {
      console.log(`ok  mutation "${t.id}" (${t.why}) caught: module refused to load (${e.message.split('\n')[0]})`);
      continue;
    }
    const tamperBad = await runChecks(tampered);
    if (tamperBad.length === 0) {
      die(`mutation "${t.id}" (${t.why}) PASSED all checks — the gate cannot catch this tamper and is broken.`);
    }
    console.log(`ok  mutation "${t.id}" (${t.why}) caught by ${tamperBad.length} check(s), e.g.: ${tamperBad[0]}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('GREEN: lib/tracking.js body/request shape verified; all 4 mutations (path, bearer, field, status) caught — gate is mutation-proof.');
process.exit(0);
