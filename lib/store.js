// THE storage seam (PAYPAL-P1-DURABLE-STATE-1 / PAYPAL-P2-WORKER-PORT-1; plan §2, §3).
//
// The only file that knows which backend is in use:
//   - local/dev: node:sqlite (DatabaseSync) at data/store.db (gitignored)
//   - Worker:    Cloudflare D1 via the `DB` binding — same schema, same interface
// (NOT Workers KV — plan §2 box: the 1,000 writes/day free cap fails operations
// on a webhook-driven app; D1 is SQLite in the account already in use.)
//
// The interface is async on both backends. Node builtins are loaded ONLY via
// dynamic import inside the sqlite backend's lazy open: this module sits in the
// Worker import graph, and Workers must not statically pull node builtins
// (the sqlite path is never executed there — createStore({ d1 }) is).
//
// Entities are modeled as tables, not JSON blobs, idempotency first-class via
// webhook_events' PRIMARY KEY. Set TRAILHEAD_DB to relocate the local database;
// the restart gate runs it against a scratch path. Map-value shape (camelCase)
// <-> column shape (snake_case) is translated HERE so callers keep their shapes.

// One SQL SSOT for both backends (same sqlite dialect).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orders (
    order_id   TEXT PRIMARY KEY,
    item       TEXT NOT NULL,
    qty        INTEGER NOT NULL,
    amount     REAL NOT NULL,
    status     TEXT NOT NULL,
    capture_id TEXT,
    sid        TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS captures (
    capture_id TEXT PRIMARY KEY,
    order_id   TEXT NOT NULL,
    amount     REAL,
    status     TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT PRIMARY KEY,
    turns_json TEXT NOT NULL,
    last_seen  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_events (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    processed_at TEXT,
    result       TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS disputes (
    dispute_id TEXT PRIMARY KEY,
    order_id   TEXT,
    reason     TEXT NOT NULL,
    status     TEXT NOT NULL,
    opened_at  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS actions_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
  )`,
];

const SQL = {
  upsertOrder: `
    INSERT INTO orders (order_id, item, qty, amount, status, capture_id, sid, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      item = excluded.item, qty = excluded.qty, amount = excluded.amount,
      status = excluded.status, capture_id = excluded.capture_id,
      sid = excluded.sid, created_at = excluded.created_at`,
  upsertCapture: `
    INSERT INTO captures (capture_id, order_id, amount, status, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(capture_id) DO UPDATE SET
      order_id = excluded.order_id, amount = excluded.amount,
      status = excluded.status, created_at = excluded.created_at`,
  upsertSession: `
    INSERT INTO sessions (sid, turns_json, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET turns_json = excluded.turns_json, last_seen = excluded.last_seen`,
  insertWebhookEvent: `
    INSERT INTO webhook_events (id, type, received_at, processed_at, result)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`,
  upsertDispute: `
    INSERT INTO disputes (dispute_id, order_id, reason, status, opened_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(dispute_id) DO UPDATE SET
      order_id = excluded.order_id, reason = excluded.reason,
      status = excluded.status, opened_at = excluded.opened_at`,
  insertAction: 'INSERT INTO actions_log (at, actor, action, detail) VALUES (?, ?, ?, ?)',
};

const rowToOrder = (r) => r && {
  orderId: r.order_id, item: r.item, qty: r.qty, amount: r.amount,
  status: r.status, captureId: r.capture_id, sid: r.sid, createdAt: r.created_at,
};

// ---- local/dev backend: node:sqlite, opened lazily on first method call ----
export function createSqliteStore(dbPath) {
  let opened = null; // { db, path } — set by the first method call
  const open = async () => {
    if (opened) return opened;
    const [{ DatabaseSync }, { mkdirSync }, { dirname }, { fileURLToPath }] =
      await Promise.all([import('node:sqlite'), import('node:fs'), import('node:path'), import('node:url')]);
    const path = dbPath || process.env.TRAILHEAD_DB || fileURLToPath(new URL('../data/store.db', import.meta.url));
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(SCHEMA.join(';\n'));
    opened = { db, path };
    return opened;
  };
  return {
    backend: 'node:sqlite',
    get path() { return opened?.path ?? dbPath ?? null; },
    async saveOrder(orderId, rec) {
      const { db } = await open();
      db.prepare(SQL.upsertOrder).run(String(orderId), rec.item, rec.qty, rec.amount, rec.status,
        rec.captureId ?? null, rec.sid ?? null, rec.createdAt);
    },
    async getOrder(orderId) {
      const { db } = await open();
      return rowToOrder(db.prepare('SELECT * FROM orders WHERE order_id = ?').get(String(orderId)));
    },
    async listOrders() {
      const { db } = await open();
      return db.prepare('SELECT * FROM orders').all().map(rowToOrder);
    },
    async saveCapture({ capture_id, order_id, amount, status, created_at }) {
      const { db } = await open();
      db.prepare(SQL.upsertCapture).run(String(capture_id), String(order_id), amount ?? null, status ?? null, created_at);
    },
    async listCapturesForOrder(orderId) {
      const { db } = await open();
      return db.prepare('SELECT * FROM captures WHERE order_id = ?').all(String(orderId));
    },
    async saveSession(sid, turns, lastSeen) {
      const { db } = await open();
      db.prepare(SQL.upsertSession).run(String(sid), JSON.stringify(turns), Math.floor(lastSeen));
    },
    async loadSession(sid) {
      const { db } = await open();
      const r = db.prepare('SELECT turns_json, last_seen FROM sessions WHERE sid = ?').get(String(sid));
      return r && { turns: JSON.parse(r.turns_json), lastSeen: r.last_seen };
    },
    async deleteSession(sid) {
      const { db } = await open();
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(String(sid));
    },
    async recordWebhookEvent(id, type, receivedAt, processedAt = null, result = null) {
      const { db } = await open();
      db.prepare(SQL.insertWebhookEvent).run(String(id), String(type), receivedAt, processedAt, result);
      return this.getWebhookEvent(id); // null processed_at => first sighting, not yet handled
    },
    async getWebhookEvent(id) {
      const { db } = await open();
      return db.prepare('SELECT * FROM webhook_events WHERE id = ?').get(String(id)) ?? null;
    },
    async saveDispute({ dispute_id, order_id, reason, status, opened_at }) {
      const { db } = await open();
      db.prepare(SQL.upsertDispute).run(String(dispute_id), order_id ? String(order_id) : null, reason, status, opened_at);
    },
    async getDispute(disputeId) {
      const { db } = await open();
      return db.prepare('SELECT * FROM disputes WHERE dispute_id = ?').get(String(disputeId)) ?? null;
    },
    async logAction({ actor, action, detail = null, at = new Date().toISOString() }) {
      const { db } = await open();
      db.prepare(SQL.insertAction).run(at, String(actor), String(action), detail);
    },
    async listActions(limit = 100) {
      const { db } = await open();
      return db.prepare('SELECT * FROM actions_log ORDER BY id DESC LIMIT ?').all(limit);
    },
    close() { opened?.db.close(); opened = null; },
  };
}

// ---- Worker backend: Cloudflare D1 (the `DB` binding) — Web APIs only ----
export function createD1Store(d1) {
  if (!d1) throw new Error('createD1Store: missing D1 binding');
  let schemaReady = null;
  const ensureSchema = () => (schemaReady ??= d1.batch(SCHEMA.map((s) => d1.prepare(s))).then(() => undefined));
  const run = async (sql, ...params) => { await ensureSchema(); await d1.prepare(sql).bind(...params).run(); };
  const rows = async (sql, ...params) => { await ensureSchema(); return (await d1.prepare(sql).bind(...params).all()).results; };
  const first = async (sql, ...params) => (await rows(sql, ...params))[0] ?? null;
  return {
    backend: 'd1',
    path: '(D1 binding)',
    async saveOrder(orderId, rec) {
      await run(SQL.upsertOrder, String(orderId), rec.item, rec.qty, rec.amount, rec.status,
        rec.captureId ?? null, rec.sid ?? null, rec.createdAt);
    },
    async getOrder(orderId) {
      return rowToOrder(await first('SELECT * FROM orders WHERE order_id = ?', String(orderId)));
    },
    async listOrders() {
      return (await rows('SELECT * FROM orders')).map(rowToOrder);
    },
    async saveCapture({ capture_id, order_id, amount, status, created_at }) {
      await run(SQL.upsertCapture, String(capture_id), String(order_id), amount ?? null, status ?? null, created_at);
    },
    async listCapturesForOrder(orderId) {
      return rows('SELECT * FROM captures WHERE order_id = ?', String(orderId));
    },
    async saveSession(sid, turns, lastSeen) {
      await run(SQL.upsertSession, String(sid), JSON.stringify(turns), Math.floor(lastSeen));
    },
    async loadSession(sid) {
      const r = await first('SELECT turns_json, last_seen FROM sessions WHERE sid = ?', String(sid));
      return r && { turns: JSON.parse(r.turns_json), lastSeen: r.last_seen };
    },
    async deleteSession(sid) {
      await run('DELETE FROM sessions WHERE sid = ?', String(sid));
    },
    async recordWebhookEvent(id, type, receivedAt, processedAt = null, result = null) {
      await run(SQL.insertWebhookEvent, String(id), String(type), receivedAt, processedAt, result);
      return this.getWebhookEvent(id); // null processed_at => first sighting, not yet handled
    },
    async getWebhookEvent(id) {
      return first('SELECT * FROM webhook_events WHERE id = ?', String(id));
    },
    async saveDispute({ dispute_id, order_id, reason, status, opened_at }) {
      await run(SQL.upsertDispute, String(dispute_id), order_id ? String(order_id) : null, reason, status, opened_at);
    },
    async getDispute(disputeId) {
      return first('SELECT * FROM disputes WHERE dispute_id = ?', String(disputeId));
    },
    async logAction({ actor, action, detail = null, at = new Date().toISOString() }) {
      await run(SQL.insertAction, at, String(actor), String(action), detail);
    },
    async listActions(limit = 100) {
      return rows('SELECT * FROM actions_log ORDER BY id DESC LIMIT ?', limit);
    },
    close() { /* nothing to close on a binding */ },
  };
}

// The seam's dispatch: a string = local sqlite path (the restart gate's shape);
// { d1 } = Worker binding; nothing = default local path. Backend selection and
// every backend detail stay inside this file.
export function createStore(options = {}) {
  const opts = typeof options === 'string' ? { dbPath: options } : options || {};
  if (opts.d1) return createD1Store(opts.d1);
  return createSqliteStore(opts.dbPath);
}

// One process-wide local instance (module cache makes this a singleton); the
// restart gate's child processes build their own via createStore(scratchPath).
let shared = null;
export function getStore() {
  shared ??= createStore();
  return shared;
}
