// Mechanical unit gate for the Trailhead dispute reason -> evidence map
// (PAYPAL-E6-DISPUTE-EVIDENCE-1). Zero-dependency (node: builtins only).
//
// Asserts, on lib/disputes.js (or the module given via $DISPUTES_MODULE — that
// override exists so a tampered scratch copy of the map can be pointed at this
// gate and must flip it to exit 1; SO #34 verify-by-mutation):
//   1. REASON_EVIDENCE covers EXACTLY the four E6 reasons (no unmapped additions).
//   2. assembleEvidence() builds the provide-evidence payload shape per
//      developer.paypal.com/api/disputes/ (2026-07-21) for every mapped reason.
//   3. An unknown reason throws UnknownDisputeReasonError — never a guess.
//   4. Missing/empty required fields throw — never an incomplete submission.
//   5. MUTATION-PROOF: the gate tampers a SCRATCH copy of the real map
//      (CREDIT_NOT_PROCESSED's evidence type flipped), runs the same assertions
//      against the scratch, and requires them to FAIL. The real map is never
//      modified; the scratch file is always removed.
// Exit 0 green / 1 red.

import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REAL_MODULE_URL = new URL('../lib/disputes.js', import.meta.url);
const REAL_MODULE = fileURLToPath(REAL_MODULE_URL);
const UNDER_TEST = process.env.DISPUTES_MODULE
  ? pathToFileURL(process.env.DISPUTES_MODULE).href
  : REAL_MODULE_URL.href;

// Sweep any stale mutant scratch left by a killed earlier run (shared checkout hygiene).
for (const name of readdirSync(new URL('.', import.meta.url))) {
  if (name.startsWith('.mutant-dispute-map-')) {
    try { unlinkSync(new URL(`./${name}`, import.meta.url)); } catch { /* racing run's file; its own finally will clean */ }
  }
}

// Order-insensitive structural equality (primitives/arrays/plain objects).
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (JSON.stringify(ka) !== JSON.stringify(kb)) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

// Runs every assertion against `mod`; returns failure strings (empty = pass).
function check(mod) {
  const fails = [];
  const eq = (what, got, want) => {
    if (!deepEqual(got, want)) {
      fails.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  const throws = (what, fn, wantName, wantPattern) => {
    try {
      fn();
      fails.push(`${what}: expected a throw, got none`);
    } catch (e) {
      if (e.name !== wantName) fails.push(`${what}: threw ${e.name}, want ${wantName}`);
      if (!wantPattern.test(e.message)) {
        fails.push(`${what}: message ${JSON.stringify(e.message)} does not match /${wantPattern.source}/`);
      }
    }
  };

  // 1. exact E6 coverage — the map is exactly the four page-verified reasons.
  eq(
    'REASON_EVIDENCE keys',
    Object.keys(mod.REASON_EVIDENCE).sort(),
    [
      'CREDIT_NOT_PROCESSED',
      'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      'UNAUTHORISED',
    ]
  );

  // 2. payload shape per reason (provide-evidence body for the `input` form field).
  eq(
    'assembleEvidence(MERCHANDISE_OR_SERVICE_NOT_RECEIVED)',
    mod.assembleEvidence('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', {
      carrier_name: 'UPS',
      tracking_number: '1Z999AA10123456784',
    }),
    {
      evidences: [
        {
          evidence_type: 'PROOF_OF_FULFILLMENT',
          evidence_info: { tracking_info: { carrier_name: 'UPS', tracking_number: '1Z999AA10123456784' } },
        },
      ],
    }
  );
  eq(
    'assembleEvidence(MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED)',
    mod.assembleEvidence('MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', {
      notes: 'Listing states solid walnut; return policy: 30 days, buyer pays return postage.',
    }),
    {
      evidences: [
        {
          evidence_type: 'OTHER',
          evidence_info: {},
          notes: 'Listing states solid walnut; return policy: 30 days, buyer pays return postage.',
        },
      ],
    }
  );
  eq(
    'assembleEvidence(UNAUTHORISED)',
    mod.assembleEvidence('UNAUTHORISED', {
      carrier_name: 'USPS',
      tracking_number: '9400111899223197428490',
    }),
    {
      evidences: [
        {
          evidence_type: 'PROOF_OF_FULFILLMENT',
          evidence_info: { tracking_info: { carrier_name: 'USPS', tracking_number: '9400111899223197428490' } },
        },
      ],
    }
  );
  eq(
    'assembleEvidence(CREDIT_NOT_PROCESSED)',
    mod.assembleEvidence('CREDIT_NOT_PROCESSED', { refund_id: '3XC109123U4567890' }),
    {
      evidences: [
        {
          evidence_type: 'PROOF_OF_REFUND',
          evidence_info: { refund_info: { refund_id: '3XC109123U4567890' } },
        },
      ],
    }
  );

  // 3. unknown reason -> explicit refusal, never a guess.
  throws(
    'unknown-reason refusal (ITEM_NOT_RECEIVED)',
    () => mod.assembleEvidence('ITEM_NOT_RECEIVED', { carrier_name: 'UPS', tracking_number: 'x' }),
    'UnknownDisputeReasonError',
    /ITEM_NOT_RECEIVED/
  );

  // 4. missing/empty required fields -> refusal, never an incomplete submission.
  throws(
    'missing-field refusal (CREDIT_NOT_PROCESSED, {})',
    () => mod.assembleEvidence('CREDIT_NOT_PROCESSED', {}),
    'Error',
    /refund_id/
  );
  throws(
    'missing-field refusal (MERCHANDISE_OR_SERVICE_NOT_RECEIVED, carrier only)',
    () => mod.assembleEvidence('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', { carrier_name: 'UPS', tracking_number: '   ' }),
    'Error',
    /tracking_number/
  );

  return fails;
}

let mod;
try {
  mod = await import(UNDER_TEST);
} catch (e) {
  console.error(`RED: cannot import module under test (${UNDER_TEST}): ${e.message}`);
  process.exit(1);
}

const fails = check(mod);
if (fails.length > 0) {
  console.error(`RED: check-dispute-map — ${fails.length} assertion failure(s) against ${UNDER_TEST}:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}

// 5. MUTATION-PROOF: tamper a scratch copy of the REAL map and require the same
// assertions to fail against it. Tamper = flip CREDIT_NOT_PROCESSED's evidence
// type everywhere in the copy (split/join = replace-all, so comments cannot
// absorb the token). The real module is read, never written.
const scratchUrl = new URL(`./.mutant-dispute-map-${process.pid}-${Date.now()}.mjs`, import.meta.url);
let mutFails;
try {
  const src = readFileSync(REAL_MODULE_URL, 'utf8');
  const mutant = src.split('PROOF_OF_REFUND').join('PROOF_OF_FULFILLMENT');
  if (mutant === src) {
    console.error('RED: mutation was a no-op (token PROOF_OF_REFUND absent from lib/disputes.js) — the gate cannot self-verify its tamper. Fix the mutation step.');
    process.exit(1);
  }
  writeFileSync(scratchUrl, mutant);
  mutFails = check(await import(scratchUrl.href));
} finally {
  try { unlinkSync(scratchUrl); } catch { /* already gone */ }
}

if (mutFails.length === 0) {
  console.error('RED: MUTATION-PROOF FAILED — the tampered scratch map passed every assertion, so this gate is blind to map corruption. Exit 1.');
  process.exit(1);
}

console.log(
  `GREEN: REASON_EVIDENCE covers exactly the 4 E6 reasons; all 4 assembleEvidence payloads match the Disputes API shape ` +
    `(PROOF_OF_FULFILLMENT tracking_info, OTHER notes, PROOF_OF_REFUND refund_info); unknown-reason and missing-field refusals throw. ` +
    `MUTATION-PROOF: scratch copy of lib/disputes.js with CREDIT_NOT_PROCESSED flipped PROOF_OF_REFUND->PROOF_OF_FULFILLMENT produced ` +
    `${mutFails.length} failure(s) — the gate correctly rejects a tampered map (exit 1); scratch removed.`
);
process.exit(0);
