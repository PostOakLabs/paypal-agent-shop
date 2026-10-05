// Thin PayPal sandbox client — zero dependencies, token cached until near expiry.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    .filter(([, v]) => v !== '')
);

const base = env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');

let cached = { token: null, expires: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.expires) return cached.token;
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`paypal token ${r.status}: ${JSON.stringify(body)}`);
  cached = { token: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 };
  return cached.token;
}

async function call(method, path, payload) {
  const token = await accessToken();
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`paypal ${method} ${path} ${r.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

export const paypal = {
  createOrder: ({ title, amount, currency = 'USD', origin }) =>
    call('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ description: title.slice(0, 127), amount: { currency_code: currency, value: amount.toFixed(2) } }],
      application_context: {
        brand_name: 'Trailhead Outfitters (sandbox)',
        user_action: 'PAY_NOW',
        return_url: `${origin}/?paypal=return`,
        cancel_url: `${origin}/?paypal=cancel`,
      },
    }),
  getOrder: (id) => call('GET', `/v2/checkout/orders/${id}`),
  captureOrder: (id) => call('POST', `/v2/checkout/orders/${id}/capture`),
  refund: (captureId, amount) =>
    call('POST', `/v2/payments/captures/${captureId}/refund`, amount ? { amount: { value: amount.toFixed(2), currency_code: 'USD' } } : {}),
  clientId: env.PAYPAL_CLIENT_ID,
  env: base.includes('sandbox') ? 'sandbox' : 'live',
};

// Exposed for lib/tracking.js (PAYPAL-E1-TRACKING-1) so the Add Tracking client
// reuses this module's token path and API base — no duplicate auth anywhere.
export { accessToken as paypalAccessToken, base as paypalBase };
