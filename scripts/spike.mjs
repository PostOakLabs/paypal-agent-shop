// Day-1 spike: proves sandbox credentials and the create -> approve -> capture
// loop before any app code exists. Zero dependencies, Node >= 18.
//
//   node scripts/spike.mjs token
//   node scripts/spike.mjs create       (prints buyer-approval link + order id)
//   node scripts/spike.mjs capture <ORDER_ID>
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    .filter(([, v]) => v !== '')
);

const base = env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
  console.error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env');
  process.exit(1);
}
const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');

async function token() {
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`token ${r.status}: ${body}`);
  return JSON.parse(body).access_token;
}

async function createOrder(t) {
  const r = await fetch(`${base}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          description: 'Spike order - lifecycle agent day-1 gate',
          amount: { currency_code: 'USD', value: '11.10' },
        },
      ],
      // Sandbox-only placeholders; the real app points these at the hosted demo.
      application_context: {
        brand_name: 'Lifecycle Agent (sandbox)',
        return_url: 'https://example.com/success',
        cancel_url: 'https://example.com/cancel',
      },
    }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`create ${r.status}: ${body}`);
  const order = JSON.parse(body);
  const approve = order.links?.find((l) => l.rel === 'approve')?.href;
  console.log(`order id: ${order.id}`);
  console.log(`approve:  ${approve}`);
  console.log('Open the approve link, pay with a SANDBOX personal account, then:');
  console.log(`  node scripts/spike.mjs capture ${order.id}`);
}

async function captureOrder(t, id) {
  const r = await fetch(`${base}/v2/checkout/orders/${id}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`capture ${r.status}: ${body}`);
  const cap = JSON.parse(body);
  console.log(`status:  ${cap.status}`);
  console.log(`capture: ${cap.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? '(see response)'}`);
}

const [cmd, arg] = process.argv.slice(2);
try {
  const t = await token();
  if (cmd === 'token') console.log('credentials OK, token acquired');
  else if (cmd === 'create') await createOrder(t);
  else if (cmd === 'capture' && arg) await captureOrder(t, arg);
  else {
    console.log('usage: node scripts/spike.mjs token | create | capture <ORDER_ID>');
    process.exit(2);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
