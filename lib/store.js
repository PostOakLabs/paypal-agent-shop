// THE storage seam (PAYPAL-P1-DURABLE-STATE-1 / PAYPAL-PERMANENT-VALUE-PLAN-2026-10-04 §2).
//
// The only file in this repo that knows which backend is in use: node:sqlite
// (DatabaseSync) locally now; the Worker port (plan §3) implements the same
// async interface over Cloudflare D1. Deliberately NOT Workers KV — plan §2 box:
// the free tier's 1,000 writes/day cap FAILS operations (no throttling), and a
// webhook-driven app writes on every event; D1 is SQLite in the account already
// in use, so no new third party.
//
// The interface is async because the Worker backend is; the local backend is
// synchronous underneath (DatabaseSync) and resolves immediately.
//
// Entities are modeled as tables, not JSON blobs (plan §2), idempotency
// first-class via webhook_events' PRIMARY KEY. Wired in this row: orders
// write-through + boot hydration (lib/agent.js, server.js) and session
// persistence (server.js). captures / webhook_events / disputes / actions_log
// are modeled here and exercised by scripts/check-store-restart.mjs; their
// producers land with plan §4 (webhook idempotency) and §5 (disputes).
// Known gap, outside this row's fence: lib/mcp.js refund mutates the orders
// Map in memory only — its write-through rides the row that touches mcp.js.
//
// Set TRAILHEAD_DB to relocate the database (the restart gate runs it against
// a scratch path); default is data/store.db, which is gitignored.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DB_PATH = process.env.TRAILHEAD_DB || fileURLToPath(new URL('../data/store.db', import.meta.url));

// Map-value shape (camelCase, exactly what callers hold) <-> column shape
// (snake_case) is translated HERE so callers keep their shapes across backends.
export function createStore(dbPath = DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id   TEXT PRIMARY KEY,
      item       TEXT NOT NULL,
      qty        INTEGER NOT NULL,
      amount     REAL NOT NULL,
      status     TEXT NOT NULL,
      capture_id TEXT,
      sid        TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS captures (
      capture_id TEXT PRIMARY KEY,
      order_id   TEXT NOT NULL,
      amount     REAL,
      status     TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid        TEXT PRIMARY KEY,
      turns_json TEXT NOT NULL,
      last_seen  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      received_at  TEXT NOT NULL,
      processed_at TEXT,
      result       TEXT
    );
    CREATE TABLE IF NOT EXISTS disputes (
      dispute_id TEXT PRIMARY KEY,
      order_id   TEXT,
      reason     TEXT NOT NULL,
      status     TEXT NOT NULL,
      opened_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS actions_log (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      at     TEXT NOT NULL,
      actor  TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT
    );
  `);

  const insertOrder = db.prepare(`
    INSERT INTO orders (order_id, item, qty, amount, status, capture_id, sid, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      item = excluded.item, qty = excluded.qty, amount = excluded.amount,
      status = excluded.status, capture_id = excluded.capture_id,
      sid = excluded.sid, created_at = excluded.created_at
  `);
  const insertCapture = db.prepare(`
    INSERT INTO captures (capture_id, order_id, amount, status, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(capture_id) DO UPDATE SET
      order_id = excluded.order_id, amount = excluded.amount,
      status = excluded.status, created_at = excluded.created_at
  `);
  const insertSession = db.prepare(`
    INSERT INTO sessions (sid, turns_json, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET turns_json = excluded.turns_json, last_seen = excluded.last_seen
  `);
  const insertWebhookEvent = db.prepare(`
    INSERT INTO webhook_events (id, type, received_at, processed_at, result)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertDispute = db.prepare(`
    INSERT INTO disputes (dispute_id, order_id, reason, status, opened_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(dispute_id) DO UPDATE SET
      order_id = excluded.order_id, reason = excluded.reason,
      status = excluded.status, opened_at = excluded.opened_at
  `);

  const rowToOrder = (r) => r && {
    orderId: r.order_id, item: r.item, qty: r.qty, amount: r.amount,
    status: r.status, captureId: r.capture_id, sid: r.sid, createdAt: r.created_at,
  };

  return {
    backend: 'node:sqlite',
    path: dbPath,

    // ---- orders: { item, qty, amount, status, captureId, sid, createdAt } ----
    async saveOrder(orderId, rec) {
      insertOrder.run(String(orderId), rec.item, rec.qty, rec.amount, rec.status,
        rec.captureId ?? null, rec.sid ?? null, rec.createdAt);
    },
    async getOrder(orderId) {
      return rowToOrder(db.prepare('SELECT * FROM orders WHERE order_id = ?').get(String(orderId)));
    },
    async listOrders() {
      return db.prepare('SELECT * FROM orders').all().map(rowToOrder);
    },

    // ---- captures ----
    async saveCapture({ capture_id, order_id, amount, status, created_at }) {
      insertCapture.run(String(capture_id), String(order_id), amount ?? null, status ?? null, created_at);
    },
    async listCapturesForOrder(orderId) {
      return db.prepare('SELECT * FROM captures WHERE order_id = ?').all(String(orderId));
    },

    // ---- sessions: turns as JSON (a chat log, not queryable data) ----
    async saveSession(sid, turns, lastSeen) {
      insertSession.run(String(sid), JSON.stringify(turns), Math.floor(lastSeen));
    },
    async loadSession(sid) {
      const r = db.prepare('SELECT turns_json, last_seen FROM sessions WHERE sid = ?').get(String(sid));
      return r && { turns: JSON.parse(r.turns_json), lastSeen: r.last_seen };
    },
    async deleteSession(sid) {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(String(sid));
    },

    // ---- webhook_events: idempotency first-class (PK dedupes, plan §4.2) ----
    async recordWebhookEvent(id, type, receivedAt, processedAt = null, result = null) {
      insertWebhookEvent.run(String(id), String(type), receivedAt, processedAt, result);
      return this.getWebhookEvent(id); // null processed_at => first sighting, not yet handled
    },
    async getWebhookEvent(id) {
      return db.prepare('SELECT * FROM webhook_events WHERE id = ?').get(String(id)) ?? null;
    },

    // ---- disputes ----
    async saveDispute({ dispute_id, order_id, reason, status, opened_at }) {
      insertDispute.run(String(dispute_id), order_id ? String(order_id) : null, reason, status, opened_at);
    },
    async getDispute(disputeId) {
      return db.prepare('SELECT * FROM disputes WHERE dispute_id = ?').get(String(disputeId)) ?? null;
    },

    // ---- actions_log: append-only audit trail ----
    async logAction({ actor, action, detail = null, at = new Date().toISOString() }) {
      db.prepare('INSERT INTO actions_log (at, actor, action, detail) VALUES (?, ?, ?, ?)')
        .run(at, String(actor), String(action), detail);
    },
    async listActions(limit = 100) {
      return db.prepare('SELECT * FROM actions_log ORDER BY id DESC LIMIT ?').all(limit);
    },

    close() { db.close(); },
  };
}

// One process-wide instance (module cache makes this a singleton); the gate's
// child processes build their own via createStore(scratchPath) instead.
let shared = null;
export function getStore() {
  shared ??= createStore();
  return shared;
}
