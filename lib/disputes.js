// Dispute reason -> evidence mapping for Trailhead (PAYPAL-E6-DISPUTE-EVIDENCE-1).
//
// Source: developer.paypal.com/api/disputes/ — "Use Disputes API" (page updated
// 2026-07-21; mapping live-probed 2026-10-04). PayPal maps each dispute reason to
// the evidence the seller must submit via
//   POST /v1/customer/disputes/{id}/provide-evidence
// which takes multipart/form-data: the JSON returned by assembleEvidence() rides
// in the `input` form field (`;type=application/json`); document files ride as
// separate parts (`file1=@doc.pdf`) — PAYPAL-PERMANENT-VALUE-PLAN-2026-10-04.md §5.
//
// This row is lookup + assembly ONLY. Wiring into lib/agent.js / server.js is
// later-phase work (plan §4, §5) and is fenced OUT of PAYPAL-E6-DISPUTE-EVIDENCE-1.
// Gate: scripts/check-dispute-map.mjs (unit gate + verify-by-mutation, SO #34).

// Canonical Disputes-API reasons -> evidence type + required context fields.
// Exactly the four E6-verified reasons; anything else must be refused, never
// guessed (assembleEvidence throws UnknownDisputeReasonError for unknown reasons).
export const REASON_EVIDENCE = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: {
    evidence_type: 'PROOF_OF_FULFILLMENT',
    required: ['carrier_name', 'tracking_number'],
    why: 'prove delivery: carrier name + tracking number for the shipment',
  },
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: {
    evidence_type: 'OTHER',
    required: ['notes'],
    why: 'product description proving as-described condition, or the return policy text',
  },
  UNAUTHORISED: {
    evidence_type: 'PROOF_OF_FULFILLMENT',
    required: ['carrier_name', 'tracking_number'],
    why: 'prove the goods reached the cardholder (or their address) with carrier + tracking',
  },
  CREDIT_NOT_PROCESSED: {
    evidence_type: 'PROOF_OF_REFUND',
    required: ['refund_id'],
    why: 'the refund transaction id showing the credit was issued',
  },
};

// Thrown when a reason is outside REASON_EVIDENCE. The future triage agent must
// surface this to the merchant — inventing evidence for an unmapped reason is a
// legal submission to PayPal and is exactly what this row forbids.
export class UnknownDisputeReasonError extends Error {
  constructor(reason) {
    super(
      `assembleEvidence: unknown dispute reason ${JSON.stringify(reason)}; ` +
        `known reasons: ${Object.keys(REASON_EVIDENCE).join(', ')}. Refusing to guess evidence.`
    );
    this.name = 'UnknownDisputeReasonError';
    this.reason = reason;
  }
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

// Build the provide-evidence request body — the JSON that goes into the `input`
// form field: { evidences: [{ evidence_type, evidence_info: {...}, notes? }] }.
//   PROOF_OF_FULFILLMENT -> evidence_info.tracking_info { carrier_name, tracking_number }
//   PROOF_OF_REFUND      -> evidence_info.refund_info { refund_id }
//   OTHER                -> narrative (product description / return policy) in `notes`
// Optional ctx.notes adds free-text context alongside typed evidence.
// Throws UnknownDisputeReasonError for an unknown reason; throws on missing/empty
// required fields (an incomplete provide-evidence submission is still a submission).
export function assembleEvidence(reason, ctx = {}) {
  const spec = REASON_EVIDENCE[reason];
  if (!spec) throw new UnknownDisputeReasonError(reason);

  const missing = spec.required.filter((f) => isBlank(ctx[f]));
  if (missing.length > 0) {
    throw new Error(
      `assembleEvidence: ${reason} requires ${spec.evidence_type} evidence; ` +
        `missing required field(s): ${missing.join(', ')}. Refusing to submit incomplete evidence to PayPal.`
    );
  }

  const evidence = { evidence_type: spec.evidence_type, evidence_info: {} };
  if (spec.evidence_type === 'PROOF_OF_FULFILLMENT') {
    evidence.evidence_info.tracking_info = {
      carrier_name: ctx.carrier_name,
      tracking_number: ctx.tracking_number,
    };
  } else if (spec.evidence_type === 'PROOF_OF_REFUND') {
    evidence.evidence_info.refund_info = { refund_id: ctx.refund_id };
  } else {
    // OTHER: no typed sub-object — the required narrative rides in evidence-level notes.
    evidence.notes = ctx.notes;
  }
  if (!isBlank(ctx.notes) && spec.evidence_type !== 'OTHER') {
    evidence.notes = ctx.notes;
  }
  return { evidences: [evidence] };
}
