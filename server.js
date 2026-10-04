// Trailhead Outfitters — zero-dependency server: static UI + agent + PayPal sandbox APIs.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { paypal } from './lib/paypal.js';
import { agentTurn, orders } from './lib/agent.js';
import { handleMcp } from './lib/mcp.js';

const PUBLIC = new URL('./public', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
const history = []; // single-session demo history (last 16 turns sent to the model)

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const origin = `${url.protocol}//${url.host}`;
  try {
    if (url.pathname === '/mcp' && req.method === 'POST') return handleMcp(req, res, origin);
    if (url.pathname === '/api/config') {
      return json(res, 200, { clientId: paypal.clientId, env: paypal.env, model: 'glm-5.3-flash', store: 'Trailhead Outfitters' });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { message } = await readBody(req);
      if (!message?.trim()) return json(res, 400, { error: 'empty message' });
      const turn = await agentTurn(message, history, origin);
      history.push({ role: 'user', content: message }, { role: 'assistant', content: turn.reply });
      return json(res, 200, turn);
    }
    if (url.pathname.startsWith('/api/capture/') && req.method === 'POST') {
      const id = url.pathname.split('/').pop();
      const out = await paypal.captureOrder(id);
      const rec = orders.get(id);
      if (rec) {
        rec.status = out.status;
        rec.captureId = out.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null;
      }
      return json(res, 200, { status: out.status, captureId: rec?.captureId, orderId: id });
    }
    if (url.pathname === '/api/orders') {
      return json(res, 200, { orders: [...orders.values()].map((o, i) => ({ n: i + 1, ...o })) });
    }

    // static files
    let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const path = join(PUBLIC, file);
    if (existsSync(path) && !path.endsWith('/')) {
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
      return res.end(readFileSync(path));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

const port = Number(process.env.PORT || 8788);
server.listen(port, () => console.log(`Trailhead Outfitters ready: http://localhost:${port}`));
