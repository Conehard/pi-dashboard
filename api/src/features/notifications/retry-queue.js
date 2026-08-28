import { db } from '../../lib/db.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('notification-retry-queue')
const POLL_INTERVAL_MS = 60 * 1000
const BACKOFF_MINUTES = [2, 10, 30]
const MAX_ATTEMPTS = BACKOFF_MINUTES.length

db.exec(`
  CREATE TABLE IF NOT EXISTS notification_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    title TEXT,
    message TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notification_queue_next ON notification_queue(next_attempt_at);
`)

const statements = {
  insert: db.prepare(`
    INSERT INTO notification_queue (event_type, title, message, attempts, next_attempt_at, created_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `),
  listDue: db.prepare('SELECT * FROM notification_queue WHERE next_attempt_at <= ? ORDER BY next_attempt_at ASC'),
  bump: db.prepare('UPDATE notification_queue SET attempts = ?, next_attempt_at = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM notification_queue WHERE id = ?')
}

export function enqueueRetry (eventType, { title, message }) {
  const now = new Date()
  const nextAttempt = new Date(now.getTime() + BACKOFF_MINUTES[0] * 60 * 1000)
  statements.insert.run(eventType, title || null, message, nextAttempt.toISOString(), now.toISOString())
}

async function getAttemptSend () {
  const mod = await import('./dispatch.js')
  return mod.attemptSend
}

async function processDueRetries () {
  const due = statements.listDue.all(new Date().toISOString())
  if (due.length === 0) return

  const attemptSend = await getAttemptSend()
  for (const row of due) {
    const result = await attemptSend(row.event_type, { title: row.title, message: row.message })
    if (result.ok || result.skip) {
      statements.remove.run(row.id)
      if (result.ok) log.info(`retry bem-sucedido pra "${row.event_type}" (tentativa ${row.attempts + 1})`)
      continue
    }

    const attempts = row.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      log.error(`desistindo de "${row.event_type}" após ${attempts + 1} tentativas: ${result.error}`)
      statements.remove.run(row.id)
      continue
    }
    const nextAttempt = new Date(Date.now() + BACKOFF_MINUTES[attempts] * 60 * 1000)
    statements.bump.run(attempts, nextAttempt.toISOString(), row.id)
  }
}

export function startNotificationRetryPoller () {
  setInterval(() => {
    processDueRetries().catch((err) => log.error('retry poller falhou', err.message))
  }, POLL_INTERVAL_MS)
  log.info(`notification retry poller started (every ${POLL_INTERVAL_MS}ms)`)
}
