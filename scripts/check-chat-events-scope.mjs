// Mechanical scope gate for the chat->order event path (PAYPAL-P0-CHAT-EVENTS-1).
//
// The 784adce regression: `events.push({ type: 'order_created', ... })` was emitted
// inside module-scope `runTool`, but `events` is declared inside `agentTurn` — a
// ReferenceError swallowed by the tool-loop try/catch, so the UI never received the
// `order_created` event and never rendered the PayPal button.
//
// This gate asserts, on lib/agent.js:
//   1. `events.push` occurs EXACTLY ONCE (a call site; comments/strings ignored), and
//   2. that occurrence sits INSIDE the body of `export async function agentTurn`.
// Exit 0 green / 1 red. Zero-dependency (node: builtins only).
import { readFileSync } from 'node:fs';

const file = new URL('../lib/agent.js', import.meta.url);
let src;
try {
  src = readFileSync(file, 'utf8');
} catch (e) {
  console.error(`RED: cannot read lib/agent.js (${e.message})`);
  process.exit(1);
}

// Mask comments and string/template-literal contents with spaces, preserving every
// index and newline, so brace matching and call-site counting see code only.
// Template `${...}` expressions stay code: `${` pushes a return-to-template marker
// plus a per-expression brace depth; the matching `}` (at depth 0) pops back into
// template text. The `${`'s own `{` stays visible, uncounted, so every expression
// contributes one balanced brace pair to the masked stream.
function mask(src) {
  const out = src.split('');
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  const stack = [];  // return-to-'tpl' marker, one per open ${ expression
  const depths = []; // parallel: brace depth inside each open ${ expression
  let state = 'code'; // code | line | block | squote | dquote | tpl
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; blank(i); blank(i + 1); i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; blank(i); blank(i + 1); i += 2; continue; }
      if (c === "'") { state = 'squote'; blank(i); i++; continue; }
      if (c === '"') { state = 'dquote'; blank(i); i++; continue; }
      if (c === '`') { state = 'tpl'; blank(i); i++; continue; }
      if (c === '{' && stack.length > 0) depths[depths.length - 1]++;
      if (c === '}') {
        if (stack.length > 0) {
          if (depths[depths.length - 1] === 0) { stack.pop(); depths.pop(); state = 'tpl'; } // closes a ${ expression
          else depths[depths.length - 1]--;
        }
        i++; continue; // visible either way — pairs with the ${'s own visible `{`
      }
      i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'code'; else blank(i);
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { blank(i); blank(i + 1); state = 'code'; i += 2; continue; }
      blank(i); i++; continue;
    }
    if (state === 'squote') {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === "'") { state = 'code'; blank(i); i++; continue; }
      blank(i); i++; continue;
    }
    if (state === 'dquote') {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '"') { state = 'code'; blank(i); i++; continue; }
      blank(i); i++; continue;
    }
    // state === 'tpl': inside template text
    if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
    if (c === '`') { state = 'code'; blank(i); i++; continue; }
    if (c === '$' && next === '{') { stack.push('tpl'); depths.push(0); state = 'code'; blank(i); i += 2; continue; } // `$` blanked; `{` stays visible, uncounted
    blank(i); i++; continue;
  }
  return out.join('');
}

const masked = mask(src);

function lineOf(index) {
  return src.slice(0, index).split('\n').length;
}

// Assert 1: exactly one `events.push` call site (comments/strings don't count).
const NEEDLE = 'events.push';
const hits = [];
let at = masked.indexOf(NEEDLE);
while (at !== -1) { hits.push(at); at = masked.indexOf(NEEDLE, at + 1); }

if (hits.length === 0) {
  console.error('RED: `events.push` never occurs in lib/agent.js — the order_created event is not emitted, so the UI can never render the PayPal button.');
  process.exit(1);
}
if (hits.length > 1) {
  console.error(`RED: \`events.push\` occurs ${hits.length} times in lib/agent.js (lines ${hits.map(lineOf).join(', ')}); it must occur exactly once, inside agentTurn's tool loop.`);
  process.exit(1);
}

// Assert 2: the single occurrence sits inside `export async function agentTurn`'s body.
const MARKER = 'export async function agentTurn';
const fnStart = masked.indexOf(MARKER);
if (fnStart === -1) {
  console.error(`RED: \`${MARKER}\` not found in lib/agent.js — cannot verify event scope.`);
  process.exit(1);
}
const open = masked.indexOf('{', fnStart + MARKER.length);
if (open === -1) {
  console.error('RED: agentTurn has no opening brace — cannot verify event scope.');
  process.exit(1);
}
let depth = 0;
let fnClose = -1;
for (let i = open; i < masked.length; i++) {
  if (masked[i] === '{') depth++;
  else if (masked[i] === '}') {
    depth--;
    if (depth === 0) { fnClose = i; break; }
  }
}
if (fnClose === -1) {
  console.error('RED: agentTurn body never closes — unbalanced braces.');
  process.exit(1);
}
const [hit] = hits;
if (hit < fnStart || hit > fnClose) {
  console.error(`RED: the single \`events.push\` (line ${lineOf(hit)}) is OUTSIDE agentTurn (lines ${lineOf(fnStart)}-${lineOf(fnClose)}). Emission must live inside agentTurn's tool loop — \`events\` is scoped there; anywhere else is the 784adce button regression (ReferenceError swallowed by the tool-loop catch).`);
  process.exit(1);
}

console.log(`GREEN: \`events.push\` occurs exactly once in lib/agent.js, at line ${lineOf(hit)}, inside agentTurn's body (lines ${lineOf(fnStart)}-${lineOf(fnClose)}).`);
process.exit(0);
