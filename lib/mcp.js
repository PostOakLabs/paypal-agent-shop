// Trailhead's own MCP endpoint (zero-dep JSON-RPC): any MCP client
// can browse the catalog, create PayPal orders, check status, and refund.
// Symmetry with PayPal's hosted MCP: the storefront is itself agent-addressable.
//
// P2: createMcp(deps) is the runtime-agnostic dispatcher (initialize/ping/
// tools/list/tools/call -> { status, payload }); createNodeMcpHandler wraps it
// for the Node server (stream body + ServerResponse), worker.mjs wraps it for
// the fetch handler (Request.json + Response.json). deps = { agent, paypal }
// where agent is createAgent()'s API (catalog, orders, createOrderForItem).

export const MUTATING_TOOLS = new Set(['trailhead_create_order', 'trailhead_refund_order']); // §0.3: bearer-gated

const TOOLS = [
  {
    name: 'trailhead_search_catalog',
    description: 'Search the Trailhead Outfitters catalog. Returns id, title, price, blurb for matches.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'trailhead_create_order',
    description: 'Create a PayPal order for a catalog item. Returns order_id, amount, and approve_url (a PayPal checkout link).',
    inputSchema: { type: 'object', properties: { item_id: { type: 'string' }, quantity: { type: 'number', default: 1 } }, required: ['item_id'] },
  },
  {
    name: 'trailhead_get_order',
    description: 'Live PayPal status of a Trailhead order (CREATED / APPROVED / COMPLETED / REFUNDED...).',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
  },
  {
    name: 'trailhead_refund_order',
    description: 'Refund a COMPLETED Trailhead order in full (uses the stored capture id).',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
  },
];

export function createMcp(deps) {
  async function callTool(name, args, origin) {
    const { agent, paypal } = deps;
    switch (name) {
      case 'trailhead_search_catalog': {
        const q = (args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = agent.catalog.items.filter((it) => q.some((w) => (it.title + ' ' + it.category + ' ' + it.blurb).toLowerCase().includes(w)));
        return { results: hits.length ? hits : agent.catalog.items.slice(0, 5) };
      }
      case 'trailhead_create_order':
        return agent.createOrderForItem(args.item_id, args.quantity, origin);
      case 'trailhead_get_order': {
        try {
          const live = await paypal.getOrder(args.order_id);
          return { order_id: args.order_id, status: live.status, amount: live.purchase_units?.[0]?.amount?.value };
        } catch {
          const rec = agent.orders.get(args.order_id);
          if (!rec) throw new Error(`order ${args.order_id} not found`);
          return { order_id: args.order_id, status: rec.status, amount: rec.amount, stale: true };
        }
      }
      case 'trailhead_refund_order': {
        const rec = agent.orders.get(args.order_id);
        if (!rec?.captureId) throw new Error(`no captured payment stored for ${args.order_id}`);
        const out = await paypal.refund(rec.captureId);
        rec.status = 'REFUNDED';
        return { refund_id: out.id, status: out.status, order_id: args.order_id };
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  // rpc: an already-parsed JSON-RPC object. Returns { status, payload } —
  // payload null means "no body" (notifications -> 202 empty).
  async function dispatch(rpc, origin, opts = {}) {
    const { id, method, params } = rpc || {};
    if (id === undefined || id === null) return { status: 202, payload: null }; // notification
    try {
      if (method === 'initialize')
        return { status: 200, payload: { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'trailhead-mcp', version: '0.1.0' } } } };
      if (method === 'ping')
        return { status: 200, payload: { jsonrpc: '2.0', id, result: {} } };
      if (method === 'tools/list')
        return { status: 200, payload: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
      if (method === 'tools/call') {
        const out = await callTool(params?.name, params?.arguments || {}, origin);
        return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } } };
      }
      return { status: 200, payload: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } } };
    } catch (e) {
      return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true } } };
    }
  }

  return { dispatch, callTool, TOOLS };
}

// Node-path responder (server.js): same wire behavior as pre-refactor handleMcp.
export function createNodeMcpHandler(deps) {
  const mcp = createMcp(deps);
  return async function handleMcp(req, res, origin) {
    let rpc;
    try { rpc = JSON.parse(await new Promise((ok, err) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); req.on('error', err); })); }
    catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const { status, payload } = await mcp.dispatch(rpc, origin);
    if (payload === null) { res.writeHead(status); return res.end(); }
    return json(res, status, payload);
  };
}

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
