let config = null;

const chat = document.getElementById('chat');
const composer = document.getElementById('composer');
const input = document.getElementById('message');

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
    <div class="buttons"></div>`;
  chat.appendChild(card);
  chat.scrollTop = chat.scrollHeight;
  if (window.paypal) {
    window.paypal.Buttons({
      createOrder: () => ev.order_id,
      onApprove: async (data) => {
        const r = await fetch(`/api/capture/${data.orderID}`, { method: 'POST' }).then((r) => r.json());
        card.querySelector('.status').outerHTML = statusChip(r.status);
        bubble('sys', `Payment captured — capture ${r.captureId}. Order ${r.orderId} is ${r.status}.`);
        refreshOrderRail();
      },
      onError: (err) => bubble('sys', `PayPal SDK error: ${err}`),
    }).render(card.querySelector('.buttons'));
  } else {
    card.querySelector('.buttons').textContent = 'PayPal SDK still loading…';
  }
}

async function refreshOrderRail() {
  const { orders } = await fetch('/api/orders').then((r) => r.json());
  const rail = document.getElementById('order-rail');
  rail.innerHTML = orders.length
    ? orders.map((o) => `<div class="order-rail-item"><span>#${o.n} ${o.item}${o.qty > 1 ? ` ×${o.qty}` : ''}</span><span class="status ${o.status}">${o.status}</span></div>`).join('')
    : '<p class="muted">No orders yet.</p>';
}

async function loadCatalog() {
  const catalog = await fetch('/data/catalog.json').then((r) => r.json());
  document.getElementById('catalog').innerHTML = catalog.items
    .map((i) => `<div class="item"><span class="p">$${i.price.toFixed(2)}</span><div class="t">${i.title}</div><div class="b">${i.blurb}</div></div>`)
    .join('');
}

async function send(message) {
  const typing = bubble('avo typing', 'Avo is thinking…');
  composer.querySelector('button').disabled = true;
  try {
    const turn = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    }).then((r) => r.json());
    typing.remove();
    if (turn.error) bubble('avo', `⚠ ${turn.error}`);
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
  config = await fetch('/api/config').then((r) => r.json());
  document.getElementById('model-chip').textContent = config.model;
  bubble('sys', `${config.store} · ${config.env} · every payment is fake sandbox money`);
  loadCatalog();
  refreshOrderRail();
  const sdk = document.createElement('script');
  sdk.src = `https://www.paypal.com/sdk/js?client-id=${config.clientId}&currency=USD&intent=capture&components=buttons`;
  sdk.onload = () => bubble('sys', 'Avo is on duty — try: “I need a tent under $300”');
  sdk.onerror = () => bubble('sys', '⚠ PayPal SDK failed to load');
  document.head.appendChild(sdk);
})();
