#!/usr/bin/env node
// Mechanical gate for the storage seam (PAYPAL-P1-DURABLE-STATE-1). Zero dependencies.
//
//   node scripts/check-store-restart.mjs            full gate (4 checks below)
//   node scripts/check-store-restart.mjs --keep     ... but keep the scratch dir (debug)
//
// Checks:
//   (a) restart-safety: seed an order + a session (+ capture/webhook/dispute/action
//       rows) into a scratch DB, then reopen that file from a FRESH PROCESS (fresh
//       DatabaseSync handle) and assert everything survived — the phase-1 exit
//       criterion "restarting the server loses no order state".
//   (b) seam uniqueness: the sqlite builtin is imported by lib/store.js and NO
//       other tracked file (enumerated via git ls-files, never a filesystem walk).
//   (c) verify-by-mutation (SO #34, quoted once): a scratch copy of lib/store.js
//       with a tampered read path (silently returns no orders) must flip the
//       restart check RED — proves the checker has teeth, not just a green habit.
//   (d) gitignore: data/store.db must be ignored, so the ledger never gets committed.
//
// Exit 0 green / 1 red.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(selfPath), '..');
const REAL_STORE = join(repoRoot, 'lib', 'store.js');
const KEEP = process.argv.includes('--keep');

// `node:sqlite` is built here from parts so this gate's own source never
// contains the literal it greps for (it would self-match in check (b)).
const NEEDLE = 'node' + ':sqlite';

const fail = (msg) => { console.error(`RED: ${msg}`); process.exit(1); };

// ---- child modes: run in a fresh process so (a) is a true restart boundary ----
const mode = process.argv.includes('--seed') ? 'seed' : process.argv.includes('--verify') ? 'verify' : null;
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

async function child(mode, dbPath, storePath) {
  const store = (await import(pathToFileURL(storePath).href)).createStore(dbPath);
  if (mode === 'seed') {
    const now = new Date().toISOString();
    await store.saveOrder('TH-GATE-ORDER-1', { item: 'Gate Test Tent', qty: 1, amount: 42.5, status: 'CREATED', captureId: 'TH-GATE-CAPTURE-1', sid: 'TH-GATE-SID-1', createdAt: now });
    await store.saveCapture({ capture_id: 'TH-GATE-CAPTURE-1', order_id: 'TH-GATE-ORDER-1', amount: 42.5, status: 'COMPLETED', created_at: now });
    await store.saveSession('TH-GATE-SID-1', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], Date.now());
    await store.recordWebhookEvent('TH-GATE-WH-1', 'PAYMENT.CAPTURE.COMPLETED', now);
    await store.saveDispute({ dispute_id: 'TH-GATE-DISP-1', order_id: 'TH-GATE-ORDER-1', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'OPEN', opened_at: now });
    await store.logAction({ actor: 'gate', action: 'seed', detail: 'check-store-restart seed' });
    store.close();
    console.log(`seeded: order/capture/session/webhook/dispute/action -> ${dbPath}`);
    process.exit(0);
  }
  // verify: every read goes through the seam in this fresh process/handle
  const order = await store.getOrder('TH-GATE-ORDER-1');
  if (!order || order.status !== 'CREATED' || order.captureId !== 'TH-GATE-CAPTURE-1') {
    console.error(`RED: order TH-GATE-ORDER-1 did not survive the reopen (got ${JSON.stringify(order)})`);
    process.exit(1);
  }
  console.log(`PROOF: order TH-GATE-ORDER-1 survives a fresh process handle (status=${order.status}, captureId=${order.captureId}, item="${order.item}", amount=${order.amount})`);
  const sess = await store.loadSession('TH-GATE-SID-1');
  if (!sess || sess.turns.length !== 2) {
    console.error(`RED: session TH-GATE-SID-1 did not survive the reopen (got ${JSON.stringify(sess)})`);
    process.exit(1);
  }
  console.log(`PROOF: session TH-GATE-SID-1 survives the reopen (${sess.turns.length} turns, lastSeen=${sess.lastSeen})`);
  const captures = await store.listCapturesForOrder('TH-GATE-ORDER-1');
  const wh = await store.getWebhookEvent('TH-GATE-WH-1');
  const disp = await store.getDispute('TH-GATE-DISP-1');
  const actions = await store.listActions();
  if (captures.length !== 1 || !wh || !disp || actions.length !== 1) {
    console.error(`RED: modeled tables did not survive (captures=${captures.length}, webhook=${!!wh}, dispute=${!!disp}, actions=${actions.length})`);
    process.exit(1);
  }
  console.log('PROOF: capture/webhook_event/dispute/actions_log rows survive the reopen');
  store.close();
  process.exit(0);
}

if (mode) await child(mode, arg('--db'), arg('--store') || REAL_STORE);

// ---- parent: the full gate ----
const runChild = (args) =>
  spawnSync(process.execPath, [selfPath, ...args], { encoding: 'utf8', cwd: repoRoot });

function expect(name, args, wantZero) {
  const r = runChild(args);
  if (r.stdout?.trim()) console.log(r.stdout.trimEnd());
  if ((r.status === 0) !== wantZero) {
    fail(`${name}: child exit ${r.status} (wanted ${wantZero ? 0 : 'non-zero'})\n${r.stderr || ''}`);
  }
  return r;
}

const scratch = join(tmpdir(), `th-store-gate-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
try {
  mkdirSync(scratch, { recursive: true });
  const db = join(scratch, 'store.db');

  // (a) restart-safety: write in one process, read back in a different one
  expect('seed', ['--seed', '--db', db], true);
  const v = expect('verify (fresh process, fresh handle)', ['--verify', '--db', db], true);
  console.log(`GREEN (a): restart-safety — order + session persisted to a scratch DB and verified from a separate process (${scratch})`);

  // (b) seam uniqueness, enumerated per SO #52 via git ls-files (never find/glob)
  const ls = spawnSync('git', ['-C', repoRoot, 'ls-files', '*.js', '*.mjs'], { encoding: 'utf8' });
  if (ls.status !== 0) fail(`git ls-files failed: ${ls.stderr}`);
  const offenders = ls.stdout.trim().split('\n').filter(Boolean)
    .filter((f) => f !== 'lib/store.js')
    .filter((f) => { try { return readFileSync(join(repoRoot, f), 'utf8').includes(NEEDLE); } catch { return false; } });
  if (offenders.length) fail(`seam violated: ${NEEDLE} imported outside lib/store.js: ${offenders.join(', ')}`);
  console.log('GREEN (b): seam uniqueness — only lib/store.js imports the sqlite builtin (all tracked .js/.mjs scanned)');

  // (c) verify-by-mutation: a lying store must flip the restart check RED
  const src = readFileSync(REAL_STORE, 'utf8');
  const TAMPER = 'SELECT * FROM orders';
  if (!src.includes(TAMPER)) fail(`mutation target "${TAMPER}" not found in lib/store.js — tamper literal drifted`);
  const tampered = join(scratch, 'store-tampered.js');
  writeFileSync(tampered, src.replace(TAMPER, 'SELECT * FROM orders WHERE 1 = 0'), 'utf8');
  expect('mutation seed (tampered store writes "successfully")', ['--seed', '--db', join(scratch, 'tampered.db'), '--store', tampered], true);
  expect('mutation verify (must be RED — tampered read path hides the order)', ['--verify', '--db', join(scratch, 'tampered.db'), '--store', tampered], false);
  console.log('GREEN (c): mutation-proof — tampering the store copy flipped the restart check to RED, so this gate detects a silently broken seam');

  // (d) the ledger never gets committed
  const ig = spawnSync('git', ['-C', repoRoot, 'check-ignore', '-q', 'data/store.db']);
  if (ig.status !== 0) fail('data/store.db is NOT gitignored — the order ledger must never be committed');
  console.log('GREEN (d): gitignore — data/store.db is ignored');

  console.log('STORE GATE GREEN: 4/4 checks passed');
} finally {
  if (!KEEP) rmSync(scratch, { recursive: true, force: true });
  else console.log(`note: scratch kept at ${scratch}`);
}
