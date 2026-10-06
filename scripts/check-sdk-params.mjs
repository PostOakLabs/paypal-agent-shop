#!/usr/bin/env node
// Static gate for the sponsor surfaces (PAYPAL-SPONSOR-SURFACES-1 item 3). Zero deps.
//
//   node scripts/check-sdk-params.mjs
//
// Asserts, on public/app.js:
//   1. the SDK is loaded with components=buttons,messages (Pay Later messaging on)
//   2. the SDK is loaded with enable-funding=venmo (Venmo in the wallet)
//   3. order cards render paypal.Messages({ amount, placement: 'product' })
//   4. the messages render is guarded (graceful fallback when unavailable)
//   5. the catalog rail fetches /api/catalog (both surfaces serve it — the
//      absorbed PAYPAL-P2-WORKER-PORT-1 finding; /data/catalog.json 404'd forever)
// Exit 0 green / 1 red. Mutation-proofed (SO #34): a scratch copy with the
// messages component stripped must flip this gate RED.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js');

function check(src) {
  const problems = [];
  if (!src.includes('components=buttons,messages')) problems.push('SDK URL missing components=buttons,messages — the Pay Later messaging component is not loaded');
  if (!src.includes('enable-funding=venmo')) problems.push('SDK URL missing enable-funding=venmo — Venmo is not in the wallet');
  if (!/paypal\.Messages\(/.test(src)) problems.push('order cards never render paypal.Messages — the merchandising surface is absent');
  if (!/amount:\s*ev\.amount\.toFixed\(2\)/.test(src)) problems.push('paypal.Messages is not wired to the order amount');
  if (!/placement:\s*'product'/.test(src)) problems.push("paypal.Messages placement is not 'product'");
  if (!/paypal\?\.Messages/.test(src)) problems.push('no paypal?.Messages guard — an unavailable messages component would break the order card');
  if (!src.includes("'/api/catalog'")) problems.push("catalog rail does not fetch '/api/catalog' (the served route) — /data/catalog.json 404s on every surface");
  return problems;
}

const fail = (msg) => { console.error(`RED: ${msg}`); process.exit(1); };
let src;
try { src = readFileSync(appPath, 'utf8'); } catch (e) { fail(`cannot read public/app.js (${e.message})`); }

const problems = check(src);
if (problems.length) fail(`${problems.length} SDK param problem(s):\n  - ${problems.join('\n  - ')}`);
console.log('GREEN: components=buttons,messages + enable-funding=venmo loaded; paypal.Messages renders with the order amount (product placement, guarded); catalog rail fetches /api/catalog');

// verify-by-mutation: strip the messages component from a scratch copy -> RED
const tampered = src.replace('components=buttons,messages', 'components=buttons');
const mProblems = check(tampered);
if (!mProblems.length) fail('mutation: messages component stripped from the scratch copy was NOT caught — checker is blind');
console.log('MUTATION-PROOF: scratch copy without the messages component produced 1 failure(s) — the gate correctly rejects a stripped SDK URL (exit 1); scratch never written');
console.log('SDK PARAMS GATE GREEN: 5 assertions + mutation proof');
