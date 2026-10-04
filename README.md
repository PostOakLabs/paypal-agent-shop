# paypal-agent-shop

> The merchant's agent — everyone's agent can check out; ours handles the whole sale.

Hackathon entry for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/)
(submission window closes **Nov 12, 2026, 12:00 pm PT**). An AI agent that runs the full
commerce lifecycle for a small merchant: sells with Pay Later / Venmo buttons, tracks the
shipment, handles refunds and disputes, and pays the seller out — PayPal sandbox only.

## Stack

Zero-dependency Node (>= 18): one server file, vanilla front-end, JSON catalog.
No npm install; run with `node server.js` after filling `.env` (see `.env.example`).

## Day-1 spike (risk gate)

Proves sandbox credentials and the create → approve → capture loop before app code exists:

```sh
node scripts/spike.mjs token     # credentials OK
node scripts/spike.mjs create    # prints buyer-approval link + order id
# approve in a browser with a SANDBOX personal account
node scripts/spike.mjs capture <ORDER_ID>
```

## PayPal surfaces (scorecard: "how thoroughly...?")

- [ ] Orders v2 create/capture
- [ ] JS SDK buttons
- [ ] Pay Later messaging
- [ ] Venmo button (US-only; sandbox rendering may vary — PayPal-only fallback)
- [ ] Webhooks (capture event)
- [ ] Refund
- [ ] Shipment tracking
- [ ] Disputes (list/show; sandbox creation is limited → webhook-replay pattern)
- [ ] Payouts (seller close-out, sandbox test values)
- [ ] Official Agent Toolkit / MCP server
- [ ] Multi-currency (FX) order

## Submission checklist

- [ ] Public repo, MIT license linked in the repo's About section
- [ ] Hosted demo URL + run-from-clean-checkout instructions
- [ ] < 3 min YouTube video, English, no third-party music/marks, sandbox accounts only
- [ ] Submit on Devpost by ~Nov 10 (hard deadline Nov 12, 12:00 pm PT)

## License

MIT
