import crypto from 'crypto'
import { db, ensureColumn } from '../../lib/db.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('auth')
export const SESSION_COOKIE = 'pi_dashboard_session'
const SESSION_TTL_DAYS = 90

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`)

ensureColumn('sessions', 'ip_address', 'ip_address TEXT')
ensureColumn('sessions', 'user_agent', 'user_agent TEXT')
ensureColumn('sessions', 'last_seen_at', 'last_seen_at TEXT')

const statements = {
  insertSession: db.prepare(`
    INSERT INTO sessions (token, created_at, expires_at, ip_address, user_agent, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getSession: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteSessionByRowid: db.prepare('DELETE FROM sessions WHERE rowid = ?'),
  deleteAllSessions: db.prepare('DELETE FROM sessions'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?'),
  listSessions: db.prepare('SELECT rowid, * FROM sessions ORDER BY created_at DESC')
}

export function createSession ({ ip, userAgent } = {}) {
  const token = crypto.randomBytes(32).toString('hex')
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
  statements.insertSession.run(
    token, now.toISOString(), expiresAt.toISOString(),
    ip || null, userAgent || null, now.toISOString()
  )
  return { token, expiresAt }
}

export function destroySession (token) {
  if (token) statements.deleteSession.run(token)
}

export function invalidateAllSessions () {
  statements.deleteAllSessions.run()
}

export function isSessionValid (token) {
  if (!token) return false
  const row = statements.getSession.get(token)
  if (!row) return false
  if (new Date(row.expires_at).getTime() < Date.now()) {
    statements.deleteSession.run(token)
    return false
  }
  statements.touchSession.run(new Date().toISOString(), token)
  return true
}

export function listSessions (currentToken) {
  return statements.listSessions.all().map((row) => ({
    id: row.rowid,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    ip: row.ip_address,
    userAgent: row.user_agent,
    isCurrent: row.token === currentToken
  }))
}

export function revokeSession (id) {
  const result = statements.deleteSessionByRowid.run(id)
  return result.changes > 0
}

export function cleanupExpiredSessions () {
  const result = statements.deleteExpiredSessions.run(new Date().toISOString())
  if (result.changes > 0) log.info(`cleaned up ${result.changes} expired session(s)`)
}

export function getCookie (req, name) {
  const header = req.headers.cookie
  if (!header) return null
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null
}

export function requireAuth (req, res, next) {
  const token = getCookie(req, SESSION_COOKIE)
  if (!isSessionValid(token)) {
    res.status(401).json({ ok: false, error: 'not authenticated' })
    return
  }
  next()
}
