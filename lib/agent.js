// The merchant's agent: GLM tool-loop over the catalog and PayPal sandbox.
import { readFileSync } from 'node:fs';
import { llm } from './llm.js';
import { paypal } from './paypal.js';
import { getStore } from './store.js';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
export { catalog };

export const orders = new Map(); // orderId -> { item, qty, amount, status, captureId, sid, createdAt }
const store = getStore();        // the runtime cache stays authoritative in-process;
                                 // mutations write through to the store seam (P1)

// Boot hydration (called from server.js before listen): rebuild the orders Map
// from the store so a restart loses no order state (plan §2 exit criteria).
export async function hydrateOrders() {
  for (const row of await store.listOrders()) {
    const { orderId, ...rec } = row;
    orders.set(orderId, rec);
  }
}

// sid: the storefront session that created the order (session-bound captures +
// /api/orders scoping). MCP-created orders pass no sid -> null, visible to admin only.
export async function createOrderForItem(itemId, qty = 1, origin, sid = null) {
  const item = catalog.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`unknown item_id ${itemId}`);
  qty = Math.max(1, Math.min(9, Math.round(qty || 1)));
  const amount = +(item.price * qty).toFixed(2);
  const order = await paypal.createOrder({ title: qty > 1 ? `${item.title} x${qty}` : item.title, amount, origin });
  const rec = { item: item.title, qty, amount, status: 'CREATED', captureId: null, sid: sid || null, createdAt: new Date().toISOString() };
  orders.set(order.id, rec);
  await store.saveOrder(order.id, rec); // write-through: the order ledger outlives the process
  return { order_id: order.id, amount, currency: 'USD', item: item.title, qty, approve_url: order.links?.find((l) => l.rel === 'approve')?.href };
}

const SYSTEM_PROMPT = `You are Avo, the merchant's agent for ${catalog.store}, a small outdoor-gear shop.
You help one customer at a time: find gear, compare prices, explain pay-in-4 vs financing, and take payment via PayPal (sandbox).
Rules:
- Only sell items from the catalog (use search_catalog; never invent products or prices).
- When the customer wants to buy, confirm the item and quantity, then call create_order and tell them to complete payment with the PayPal button that appears.
- If a purchase is over $100, proactively offer the pay-in-4 math (compute_financing) before creating the order.
- After payment, the customer may ask about their order: use get_order.
- Be concise and warm. Prices are USD.`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'search_catalog',
      description: 'Search the store catalog. Returns matching items with id, title, price, blurb.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'e.g. "tent", "warm jacket", "socks"' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compute_financing',
      description: 'Compare pay-in-4 (0% fee, four biweekly payments) with a financed monthly plan.',
      parameters: {
        type: 'object',
        properties: {
          principal: { type: 'number' },
          months: { type: 'number', description: 'for the financed option, e.g. 6' },
          apr: { type: 'number', description: 'annual percentage rate for the financed option, e.g. 12 for 12%' },
        },
        required: ['principal', 'months', 'apr'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_order',
      description: 'Create a PayPal order for a catalog item. Returns order_id; the customer then approves via the PayPal button in the UI.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          quantity: { type: 'number', description: 'default 1' },
        },
        required: ['item_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_order',
      description: 'Fetch live status of a PayPal order (approved, captured, refunded...).',
      parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    },
  },
];

async function runTool(name, args, origin, sid = null) {
  switch (name) {
    case 'search_catalog': {
      const q = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = catalog.items
        .map((it) => ({ it, score: q.reduce((s, w) => s + ((it.title + ' ' + it.category + ' ' + it.blurb).toLowerCase().includes(w) ? 1 : 0), 0) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((x) => x.it);
      return { results: hits.length ? hits : catalog.items.slice(0, 5), note: hits.length ? undefined : 'no match; showing top items' };
    }
    case 'compute_financing': {
      const { principal, months, apr } = args;
      const r = apr / 100 / 12;
      const monthly = r > 0 ? (principal * r) / (1 - Math.pow(1 + r, -months)) : principal / months;
      return {
        pay_in_4: { payments: 4, each: +(principal / 4).toFixed(2), cadence: 'every 2 weeks', total_fees: 0 },
        financed: { months, monthly: +monthly.toFixed(2), total: +(monthly * months).toFixed(2), apr },
      };
    }
    case 'create_order': {
      const created = await createOrderForItem(args.item_id, args.quantity, origin, sid);
      return { ...created, note: 'order created; customer must approve via the PayPal button or approve_url' };
    }
    case 'get_order': {
      const live = await paypal.getOrder(args.order_id);
      const rec = orders.get(args.order_id);
      return { status: live.status, amount: live.purchase_units?.[0]?.amount?.value, capture_id: rec?.captureId ?? null };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// one conversational turn: run the tool loop, return reply text + UI events
// (sid rides along so orders created in this turn are bound to the session)
export async function agentTurn(userMessage, history = [], origin, sid = null) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-16),
    { role: 'user', content: userMessage },
  ];
  const events = [];
  for (let i = 0; i < 6; i++) {
    const msg = await llm.chat(messages, tools);
    if (!msg.tool_calls?.length) return { reply: msg.content ?? '', events };
    messages.push(msg);
    for (const tc of msg.tool_calls) {
      let result;
      try {
        result = await runTool(tc.function.name, JSON.parse(tc.function.arguments || '{}'), origin, sid);
        if (tc.function.name === 'create_order') events.push({ type: 'order_created', ...result });
      } catch (e) {
        result = { error: e.message };
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return { reply: 'Sorry, I got tangled up — could you rephrase that?', events };
}
