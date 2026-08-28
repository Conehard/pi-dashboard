import { db } from '../../lib/db.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('audit')
const MAX_ENTRIES = 500

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at DESC);
`)

const statements = {
  insert: db.prepare('INSERT INTO audit_log (at, action, target, detail) VALUES (?, ?, ?, ?)'),
  list: db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?'),
  prune: db.prepare(`
    DELETE FROM audit_log
    WHERE id NOT IN (SELECT id FROM audit_log ORDER BY at DESC LIMIT ?)
  `)
}

export function logAudit (action, { target, detail } = {}) {
  try {
    statements.insert.run(new Date().toISOString(), action, target || null, detail || null)
    statements.prune.run(MAX_ENTRIES)
  } catch (err) {
    log.error(`failed to record audit entry for "${action}"`, err.message)
  }
}

export function listAudit ({ limit = 100 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), MAX_ENTRIES)
  return statements.list.all(capped).map((row) => ({
    at: row.at,
    action: row.action,
    target: row.target,
    detail: row.detail
  }))
}
