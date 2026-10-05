// PayPal Add Tracking client (PAYPAL-E1-TRACKING-1) — payload builder + request
// shape for POST /v1/shipping/trackers (developer.paypal.com/api/tracking/v1,
// docs updated 2026-08-17). Proactive tracking releases funds faster and
// pre-empts item-not-received disputes (plan §4.4, entry E1). The token path is
// REUSED from lib/paypal.js — this module never mints or caches credentials.
// The live call is wired when the capture webhook handler exists (plan §4.4,
// post Worker-port).
import { paypalAccessToken, paypalBase } from './paypal.js';

const TRACKERS_PATH = '/v1/shipping/trackers';
const STATUSES = new Set(['ON_HOLD', 'CANCELLED', 'SHIPPED', 'DELIVERED']);

// Build the exact Add Tracking request body. `captureId` becomes the tracker's
// `transaction_id` (the capture id of the captured payment).
export function buildTrackersBody({ captureId, trackingNumber, carrier, status = 'SHIPPED' }) {
  for (const [name, value] of Object.entries({ captureId, trackingNumber, carrier })) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(
        `buildTrackersBody: ${name} must be a non-empty string (got ${JSON.stringify(value ?? null)})`
      );
    }
  }
  if (!STATUSES.has(status)) {
    throw new TypeError(
      `buildTrackersBody: status must be one of ${[...STATUSES].join('|')} (got ${JSON.stringify(status)})`
    );
  }
  return {
    trackers: [
      {
        transaction_id: captureId,
        tracking_number: trackingNumber,
        carrier,
        status,
      },
    ],
  };
}

// POST one trackers[] body. `accessToken` comes from lib/paypal.js's token path
// (exported there as paypalAccessToken) — a single place mints and caches tokens.
export async function sendTracking(accessToken, body) {
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new TypeError('sendTracking: accessToken must be a non-empty string');
  }
  const r = await fetch(`${paypalBase}${TRACKERS_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`paypal POST ${TRACKERS_PATH} ${r.status}: ${JSON.stringify(out).slice(0, 400)}`);
  return out;
}

// Convenience for the future webhook handler (plan §4.4): token path + body + POST.
export async function trackCapture(opts) {
  return sendTracking(await paypalAccessToken(), buildTrackersBody(opts));
}
