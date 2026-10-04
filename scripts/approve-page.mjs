// In-context (popup) approval page for a pending sandbox order — the JS SDK
// flow the real app will use. Avoids the redirect-flow SMS challenge.
//
//   node scripts/approve-page.mjs <ORDER_ID> [AMOUNT]
// then open http://localhost:8788 and click the PayPal button.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [orderId, amount = '0.01'] = process.argv.slice(2);
if (!orderId) {
  console.error('usage: node scripts/approve-page.mjs <ORDER_ID> [AMOUNT]');
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    .filter(([, v]) => v !== '')
);
const base = env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');

async function capture(id) {
  const t = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  }).then(async (r) => {
    if (!r.ok) throw new Error(`token ${r.status}`);
    return (await r.json()).access_token;
  });
  const r = await fetch(`${base}/v2/checkout/orders/${id}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
  });
  const body = await r.json();
  return { http: r.status, status: body.status, captureId: body.purchase_units?.[0]?.payments?.captures?.[0]?.id };
}

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lifecycle Agent — sandbox spike</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1420; color: #e8ecf4;
         display: flex; flex-direction: column; align-items: center; gap: 1.25rem;
         padding-top: 10vh; }
  .card { background: #171f31; border: 1px solid #26324d; border-radius: 12px;
          padding: 2rem 3rem; text-align: center; }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 .5rem; }
  .amount { font-size: 2rem; font-weight: 700; }
  .meta { color: #8fa0bd; font-size: .8rem; margin-top: .4rem; }
  #status { min-height: 1.5rem; font-size: .9rem; color: #9fe0a7; max-width: 34rem;
            white-space: pre-wrap; text-align: left; }
</style>
</head>
<body>
  <div class="card">
    <h1>Sandbox spike checkout</h1>
    <div class="amount">US$ ${amount}</div>
    <div class="meta">order ${orderId} &middot; sandbox &middot; no real money</div>
  </div>
  <div id="paypal-buttons"></div>
  <pre id="status"></pre>
  <script src="https://www.paypal.com/sdk/js?client-id=${env.PAYPAL_CLIENT_ID}&currency=USD&intent=capture"></script>
  <script>
    paypal.Buttons({
      createOrder: () => '${orderId}',
      onApprove: async (data) => {
        document.getElementById('status').textContent = 'capturing…';
        const r = await fetch('/capture/' + data.orderID, { method: 'POST' });
        const out = await r.text();
        document.getElementById('status').textContent = out;
      },
      onError: (err) => {
        document.getElementById('status').textContent = 'SDK error: ' + err;
      },
    }).render('#paypal-buttons');
  </script>
</body>
</html>`;

const port = Number(env.PORT || 8788);
createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === `/capture/${orderId}`) {
    try {
      const out = await capture(orderId);
      console.log(`capture ${orderId}:`, JSON.stringify(out));
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`CAPTURE RESULT: ${JSON.stringify(out)}`);
    } catch (e) {
      console.error(`capture ${orderId} failed:`, e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`capture failed: ${e.message}`);
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(page);
}).listen(port, () => console.log(`approve page ready: http://localhost:${port} (order ${orderId}, $${amount})`));
