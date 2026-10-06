let config = null;

const chat = document.getElementById('chat');
const composer = document.getElementById('composer');
const input = document.getElementById('message');

// every API call echoes the session id issued by /api/config (§0.2 session binding)
// and surfaces server errors (400/403/413/429/5xx) as readable bubbles.
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(config?.sessionId ? { 'x-session-id': config.sessionId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function bubble(cls, text) {
  const el = document.createElement('div');
  el.className = `bubble ${cls}`;
  el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function statusChip(status) {
  return `<span class="status ${status}">${status}</span>`;
}

function renderOrderCard(ev) {
  const card = document.createElement('div');
  card.className = 'order-card';
  card.dataset.orderId = ev.order_id;
  card.innerHTML = `
    <div class="row"><span class="title">${ev.item}${ev.qty > 1 ? ` ×${ev.qty}` : ''}</span>
      <span class="amount">US$ ${ev.amount.toFixed(2)}</span></div>
    <div class="row"><span class="meta">order ${ev.order_id} · PayPal sandbox</span>${statusChip('CREATED')}</div>
    <div class="paylater-messages"></div>
    <div class="buttons"></div>`;
  chat.appendChild(card);
  chat.scrollTop = chat.scrollHeight;
  // Pay Later messaging (E3): PayPal's merchandising surface — the pay-in-4 /
  // financing banner with THIS order's amount, rendered above the buttons.
  // Graceful fallback: if the messages component is unavailable (SDK variant,
  // region), the slot is removed quietly and the buttons carry the card.
  if (window.paypal?.Messages) {
    window.paypal.Messages({
      amount: ev.amount.toFixed(2),
      placement: 'product',
      style: { layout: 'text', logo: { type: 'inline' } },
    }).render(card.querySelector('.paylater-messages')).catch(() => {
      card.querySelector('.paylater-messages')?.remove();
    });
  } else {
    card.querySelector('.paylater-messages').remove();
  }
  if (window.paypal) {
    window.paypal.Buttons({
      createOrder: () => ev.order_id,
      onApprove: async (data) => {
        try {
          const r = await api(`/api/capture/${data.orderID}`, { method: 'POST' });
          card.querySelector('.status').outerHTML = statusChip(r.status);
          bubble('sys', `Payment captured — capture ${r.captureId}. Order ${r.orderId} is ${r.status}.`);
        } catch (e) {
          bubble('sys', `⚠ Capture failed: ${e.message}`);
        }
        refreshOrderRail();
      },
      onError: (err) => bubble('sys', `PayPal SDK error: ${err}`),
    }).render(card.querySelector('.buttons'));
  } else {
    card.querySelector('.buttons').textContent = 'PayPal SDK still loading…';
  }
}

async function refreshOrderRail() {
  const rail = document.getElementById('order-rail');
  try {
    const { orders } = await api('/api/orders');
    rail.innerHTML = orders.length
      ? orders.map((o) => `<div class="order-rail-item"><span>#${o.n} ${o.item}${o.qty > 1 ? ` ×${o.qty}` : ''}</span><span class="status ${o.status}">${o.status}</span></div>`).join('')
      : '<p class="muted">No orders yet.</p>';
  } catch (e) {
    rail.innerHTML = `<p class="muted">⚠ ${e.message}</p>`;
  }
}

async function loadCatalog() {
  // served by both surfaces (server.js + worker.mjs) — /data/catalog.json was a
  // 404 on both, the absorbed PAYPAL-P2 finding
  const catalog = await api('/api/catalog');
  document.getElementById('catalog').innerHTML = catalog.items
    .map((i) => `<div class="item"><span class="p">$${i.price.toFixed(2)}</span><div class="t">${i.title}</div><div class="b">${i.blurb}</div></div>`)
    .join('');
}

async function send(message) {
  const typing = bubble('avo typing', 'Avo is thinking…');
  composer.querySelector('button').disabled = true;
  try {
    const turn = await api('/api/chat', { method: 'POST', body: { message } });
    typing.remove();
    if (turn.reply) bubble('avo', turn.reply);
    for (const ev of turn.events || []) if (ev.type === 'order_created') renderOrderCard(ev);
    refreshOrderRail();
  } catch (e) {
    typing.remove();
    bubble('avo', `⚠ ${e.message}`);
  } finally {
    composer.querySelector('button').disabled = false;
    input.focus();
  }
}

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  bubble('user', message);
  send(message);
});

(async function init() {
  try {
    config = await api('/api/config');
  } catch (e) {
    bubble('sys', `⚠ Could not reach the store API: ${e.message}`);
    return;
  }
  document.getElementById('model-chip').textContent = config.model;
  bubble('sys', `${config.store} · ${config.env} · every payment is fake sandbox money`);
  loadCatalog().catch((e) => { document.getElementById('catalog').innerHTML = `<p class="muted">⚠ ${e.message}</p>`; });
  refreshOrderRail();
  const sdk = document.createElement('script');
  // components=messages: Pay Later messaging blocks; enable-funding=venmo: Venmo
  // in the button wallet (US-only; sandbox may not render it — known quirk, the
  // PayPal-only fallback is by construction)
  sdk.src = `https://www.paypal.com/sdk/js?client-id=${config.clientId}&currency=USD&intent=capture&components=buttons,messages&enable-funding=venmo`;
  sdk.onload = () => bubble('sys', 'Avo is on duty — try: “I need a tent under $300”');
  sdk.onerror = () => bubble('sys', '⚠ PayPal SDK failed to load');
  document.head.appendChild(sdk);
})();
