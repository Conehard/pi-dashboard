import { db } from '../../lib/db.js'

const RETENTION_DAYS = 30
const DEFAULT_HISTORY_POINTS = 40
const MAX_HISTORY_LIMIT = 500

db.exec(`
  CREATE TABLE IF NOT EXISTS uptime_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER NOT NULL REFERENCES uptime_targets(id) ON DELETE CASCADE,
    checked_at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms INTEGER,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_uptime_checks_target ON uptime_checks(target_id, checked_at DESC);
`)

const statements = {
  insertCheck: db.prepare('INSERT INTO uptime_checks (target_id, checked_at, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?)'),
  pruneOldChecks: db.prepare('DELETE FROM uptime_checks WHERE target_id = ? AND checked_at < ?'),
  lastCheckedAt: db.prepare('SELECT checked_at FROM uptime_checks WHERE target_id = ? ORDER BY checked_at DESC LIMIT 1'),
  history: db.prepare('SELECT * FROM uptime_checks WHERE target_id = ? ORDER BY checked_at DESC LIMIT ?'),
  summary: db.prepare(`
    SELECT
      SUM(CASE WHEN checked_at >= ? THEN 1 ELSE 0 END) AS total24h,
      SUM(CASE WHEN checked_at >= ? AND ok = 1 THEN 1 ELSE 0 END) AS ok24h,
      SUM(CASE WHEN checked_at >= ? THEN 1 ELSE 0 END) AS total7d,
      SUM(CASE WHEN checked_at >= ? AND ok = 1 THEN 1 ELSE 0 END) AS ok7d
    FROM uptime_checks WHERE target_id = ?
  `)
}

export function getHistory (id, { limit = 200 } = {}) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 200, 1), MAX_HISTORY_LIMIT)
  return statements.history.all(id, cappedLimit).map((r) => ({
    checkedAt: r.checked_at,
    ok: !!r.ok,
    latencyMs: r.latency_ms,
    error: r.error
  }))
}

export function getLastCheckedAt (targetId) {
  const row = statements.lastCheckedAt.get(targetId)
  return row ? row.checked_at : null
}

export function recordCheck (targetId, { ok, latencyMs, error }) {
  const now = new Date().toISOString()
  statements.insertCheck.run(targetId, now, ok ? 1 : 0, latencyMs ?? null, error || null)
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  statements.pruneOldChecks.run(targetId, cutoff)
}

export function getRecentSummary (targetId, points = DEFAULT_HISTORY_POINTS) {
  const checks = statements.history.all(targetId, points)
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const summaryRow = statements.summary.get(since24h, since24h, since7d, since7d, targetId)

  return {
    lastCheck: checks[0]
      ? { checkedAt: checks[0].checked_at, ok: !!checks[0].ok, latencyMs: checks[0].latency_ms, error: checks[0].error }
      : null,
    recentChecks: checks.reverse().map((c) => ({ checkedAt: c.checked_at, ok: !!c.ok, latencyMs: c.latency_ms })),
    uptimePercent24h: summaryRow.total24h > 0 ? Number(((summaryRow.ok24h / summaryRow.total24h) * 100).toFixed(1)) : null,
    uptimePercent7d: summaryRow.total7d > 0 ? Number(((summaryRow.ok7d / summaryRow.total7d) * 100).toFixed(1)) : null
  }
}
