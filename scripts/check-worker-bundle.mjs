#!/usr/bin/env node
// Static gate for the Worker bundle (PAYPAL-P2-WORKER-PORT-1 item 5). Zero deps.
//
//   node scripts/check-worker-bundle.mjs
//
// Checks:
//   (a) worker-facing modules (worker.mjs + the lib modules it imports) carry no
//       STATIC import of any node builtin, and worker.mjs names no builtin at
//       all. Dynamic import() of a builtin is permitted only inside the three
//       lib modules that guard it to the Node path (paypal/llm env singleton,
//       the sqlite seam's lazy open) — it never executes on the Worker runtime.
//   (b) the fetch handler + every route server.js serves are present in worker.mjs.
//   (c) deploy-worker.mjs touches exactly one script name — {WORKER_NAME} from
//       .env, always interpolated — plus the d1/subdomain endpoints; no account
//       API surface beyond those (zones/routes/DNS paths would fail here).
//   (d) no secret VALUE from .env appears in any tracked file (fail-closed:
//       no .env -> RED). Values are never printed.
//   (e) mutation-proof (SO #34, quoted once): a scratch worker.mjs with an
//       injected builtin import and a scratch deploy script with a hardcoded
//       script name must flip these checks RED.
//
// Exit 0 green / 1 red. The builtin module ids are assembled from parts so this
// gate's own source never contains the literal the store gate greps for.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = 'node' + ':';
const GRAPH = ['worker.mjs', 'lib/paypal.js', 'lib/llm.js', 'lib/agent.js', 'lib/store.js', 'lib/mcp.js'];
const DYNAMIC_OK = new Set(['lib/paypal.js', 'lib/llm.js', 'lib/store.js']);
const SECRET_NAMES = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'LLM_API_KEY', 'MCP_TOKEN', 'CF_API_TOKEN'];
const DEPLOY = 'deploy/deploy-worker.mjs';

const read = (p) => { try { return readFileSync(join(repoRoot, p), 'utf8'); } catch { return null; } };
const fail = (msg) => { console.error(`RED: ${msg}`); process.exit(1); };

function checkGraph(files) {
  const problems = [];
  for (const [path, src] of Object.entries(files)) {
    if (path === 'worker.mjs' && src.includes(NODE)) problems.push(`${path}: names a builtin module id outright`);
    if (new RegExp(`\\bfrom\\s*['"]${NODE}`).test(src) || new RegExp(`^\\s*import\\s*['"]${NODE}`, 'm').test(src) || new RegExp(`\\brequire\\s*\\(\\s*['"]${NODE}`).test(src)) {
      problems.push(`${path}: STATIC import of a node builtin (Worker graph would fail to load)`);
    }
    if (new RegExp(`\\bimport\\s*\\(\\s*['"]${NODE}`).test(src) && !DYNAMIC_OK.has(path)) {
      problems.push(`${path}: dynamic builtin import outside the guarded seam modules`);
    }
  }
  return problems;
}

function checkRoutes(workerSrc) {
  const needed = ['/healthz', '/api/config', '/api/chat', '/api/capture/', '/api/orders', `'/mcp'`, 'export default', 'async fetch'];
  return needed.filter((n) => !workerSrc.includes(n)).map((n) => `worker.mjs: missing ${n}`);
}

function checkDeployBlastRadius(src) {
  const problems = [];
  const scriptsHits = src.split('workers/scripts/').length - 1;
  const interpolated = (src.match(/workers\/scripts\/\$\{WORKER_NAME\}/g) || []).length;
  if (scriptsHits !== 2 || interpolated !== 2) {
    problems.push(`${DEPLOY}: expected exactly 2 workers-scripts endpoints (upload + subdomain), both interpolating \${WORKER_NAME}; found ${scriptsHits} hits, ${interpolated} interpolated`);
  }
  if (/workers\/scripts\/[^$'"`/\s]/.test(src)) problems.push(`${DEPLOY}: a hardcoded script name would target a script other than {WORKER_NAME}`);
  for (const forbidden in { '/zones': 1, '/dns': 1, '/routes': 1, '/firewall': 1, '/rulesets': 1 }) {
    if (src.includes(forbidden)) problems.push(`${DEPLOY}: forbidden account surface ${forbidden}`);
  }
  const paths = src.match(/\/accounts\/[^'"`\\]*/g) || [];
  for (const p of paths) {
    const ok =
      p.startsWith('/accounts/${acct}/d1/database') ||
      p.startsWith('/accounts/${acct}/workers/scripts/${WORKER_NAME}') ||
      p.startsWith('/accounts/${acct}/workers/subdomain');
    if (!ok) problems.push(`${DEPLOY}: unexpected account API path ${p}`);
  }
  return problems;
}

function checkSecrets(trackedContents, values) {
  const problems = [];
  for (const [name, value] of Object.entries(values)) {
    for (const [f, c] of Object.entries(trackedContents)) {
      if (c && c.includes(value)) problems.push(`tracked file ${f} contains the value of ${name} (secrets must ride .env / bindings only)`);
    }
  }
  return problems;
}

const files = {};
for (const f of [...GRAPH, DEPLOY]) {
  const c = read(f);
  if (c === null) fail(`cannot read ${f}`);
  files[f] = c;
}

// (a)+(b)+(c) on the real tree — (a) covers the WORKER GRAPH only; the deploy
// script is a local Node tool and may use node builtins freely
const graphFiles = Object.fromEntries(GRAPH.map((f) => [f, files[f]]));
let problems = [...checkGraph(graphFiles), ...checkRoutes(files['worker.mjs']), ...checkDeployBlastRadius(files[DEPLOY])];

// (d) no secret value in any tracked file
const envText = read('.env');
if (envText === null) fail('no .env readable — cannot prove absence of secret values (fail-closed)');
const envParsed = Object.fromEntries(envText.split(/\r?\n/).filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const secrets = Object.fromEntries(SECRET_NAMES.map((n) => [n, envParsed[n]]).filter(([, v]) => v && v.length >= 8));
const ls = spawnSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8' });
if (ls.status !== 0) fail(`git ls-files failed: ${ls.stderr}`);
const tracked = ls.stdout.trim().split('\n').filter(Boolean);
const trackedContents = {};
for (const f of tracked) trackedContents[f] = read(f);
problems.push(...checkSecrets(trackedContents, secrets));

if (problems.length) fail(`${problems.length} bundle problem(s):\n  - ${problems.join('\n  - ')}`);
console.log(`GREEN (a)-(d): worker graph clean (no static builtin imports; worker.mjs builtin-free), all routes present, deploy PUTs only \${WORKER_NAME}, no secret values in ${tracked.length} tracked files`);

// (e) verify-by-mutation: the checks must have teeth (SO #34, quoted once)
const tamperedWorker = `import { createServer } from '${NODE}http';\n${files['worker.mjs']}`;
const mWorker = checkGraph({ ...files, 'worker.mjs': tamperedWorker });
if (!mWorker.length) fail('mutation: injected builtin import in worker.mjs was NOT caught — checker is blind');
const tamperedDeploy = files[DEPLOY].replace('workers/scripts/${WORKER_NAME}', 'workers/scripts/some-other-script');
const mDeploy = checkDeployBlastRadius(tamperedDeploy);
if (!mDeploy.length) fail('mutation: hardcoded script name in the deploy PUT was NOT caught — checker is blind');
console.log('GREEN (e): mutation-proof — an injected builtin import and a hardcoded script name both flipped this gate RED');
console.log('WORKER BUNDLE GATE GREEN: 5/5 checks passed');
