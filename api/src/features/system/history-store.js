import { db, ensureColumn } from '../../lib/db.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('metrics-history')
const RETENTION_DAYS = 7
const MIN_SAMPLE_GAP_MS = 55 * 1000

db.exec(`
  CREATE TABLE IF NOT EXISTS metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    cpu_percent REAL,
    mem_percent REAL,
    temp_c REAL
  );

  CREATE INDEX IF NOT EXISTS idx_metrics_history_at ON metrics_history(at DESC);
`)
ensureColumn('metrics_history', 'cpu_percent', 'cpu_percent REAL')
ensureColumn('metrics_history', 'internet_connected', 'internet_connected INTEGER')
ensureColumn('metrics_history', 'internet_latency_ms', 'internet_latency_ms INTEGER')

const statements = {
  insert: db.prepare('INSERT INTO metrics_history (at, cpu_percent, mem_percent, temp_c, internet_connected, internet_latency_ms) VALUES (?, ?, ?, ?, ?, ?)'),
  lastAt: db.prepare('SELECT at FROM metrics_history ORDER BY at DESC LIMIT 1'),
  listSince: db.prepare('SELECT at, cpu_percent, mem_percent, temp_c, internet_connected, internet_latency_ms FROM metrics_history WHERE at >= ? ORDER BY at ASC'),
  pruneOlderThan: db.prepare('DELETE FROM metrics_history WHERE at < ?')
}

let lastSampleAtMs = 0

export function recordSampleIfDue ({ cpuPercent, memPercent, tempC, internetConnected, internetLatencyMs }) {
  const now = Date.now()
  if (now - lastSampleAtMs < MIN_SAMPLE_GAP_MS) return
  lastSampleAtMs = now

  try {
    statements.insert.run(
      new Date(now).toISOString(),
      cpuPercent ?? null,
      memPercent ?? null,
      tempC ?? null,
      internetConnected === undefined || internetConnected === null ? null : (internetConnected ? 1 : 0),
      internetLatencyMs ?? null
    )
    const cutoff = new Date(now - RETENTION_DAYS * 86400 * 1000).toISOString()
    statements.pruneOlderThan.run(cutoff)
  } catch (err) {
    log.error('failed to record metrics sample', err.message)
  }
}

export function getHistory ({ hours = 24 } = {}) {
  const clampedHours = Math.min(Math.max(Number(hours) || 24, 1), RETENTION_DAYS * 24)
  const since = new Date(Date.now() - clampedHours * 3600 * 1000).toISOString()
  return statements.listSince.all(since).map((row) => ({
    at: row.at,
    cpuPercent: row.cpu_percent,
    memPercent: row.mem_percent,
    tempC: row.temp_c,
    internetConnected: row.internet_connected === null ? null : !!row.internet_connected,
    internetLatencyMs: row.internet_latency_ms
  }))
}
