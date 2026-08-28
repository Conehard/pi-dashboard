import crypto from 'crypto'
import { db } from '../../lib/db.js'
import { createLogger } from '../../lib/logger.js'
import { logAudit } from '../audit/audit.js'
import { createSession, invalidateAllSessions } from './sessions.js'

const log = createLogger('auth')
const SCRYPT_KEYLEN = 64

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_config (
    id INTEGER PRIMARY KEY CHECK (id = 1), -- singleton row, one login for the whole app
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`)

const statements = {
  getAuthConfig: db.prepare('SELECT * FROM auth_config WHERE id = 1'),
  insertAuthConfig: db.prepare('INSERT INTO auth_config (id, username, password_hash, updated_at) VALUES (1, ?, ?, ?)'),
  updateAuthConfig: db.prepare('UPDATE auth_config SET username = ?, password_hash = ?, updated_at = ? WHERE id = 1')
}

function safeEqual (a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA)
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

function hashPassword (password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword (password, stored) {
  const [salt, hashHex] = (stored || '').split(':')
  if (!salt || !hashHex) return false
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(hashHex, 'hex')
  if (candidate.length !== expected.length) return false
  return crypto.timingSafeEqual(candidate, expected)
}

function seedAuthConfigIfNeeded () {
  if (statements.getAuthConfig.get()) return

  const envUser = process.env.BASIC_AUTH_USER || 'admin'
  const envPass = process.env.BASIC_AUTH_PASSWORD || ''
  if (!envPass) {
    log.error('No login configured yet and BASIC_AUTH_PASSWORD is not set - every login will be refused until credentials are set (fail closed, not open).')
    return
  }

  statements.insertAuthConfig.run(envUser, hashPassword(envPass), new Date().toISOString())
  log.info(`seeded login from .env for user "${envUser}" - change it from Configurações from now on`)
}

seedAuthConfigIfNeeded()

export function checkCredentials (username, password) {
  const row = statements.getAuthConfig.get()
  if (!row) {
    log.error('no login configured - refusing every login attempt')
    return false
  }
  return safeEqual(username || '', row.username) && verifyPassword(password || '', row.password_hash)
}

export function hasAuthConfig () {
  return !!statements.getAuthConfig.get()
}

export function setupCredentials ({ username, password, ip, userAgent }) {
  if (statements.getAuthConfig.get()) {
    const err = new Error('Login já configurado - use "Configurações" pra trocar.')
    err.statusCode = 409
    throw err
  }

  const user = typeof username === 'string' ? username.trim() : ''
  if (!user) {
    const err = new Error('Usuário é obrigatório.')
    err.statusCode = 400
    throw err
  }
  if (typeof password !== 'string' || password.length < 8) {
    const err = new Error('Senha precisa ter pelo menos 8 caracteres.')
    err.statusCode = 400
    throw err
  }

  statements.insertAuthConfig.run(user, hashPassword(password), new Date().toISOString())
  log.info(`login set up via first-run screen for user "${user}"`)
  return createSession({ ip, userAgent })
}

export function changeCredentials ({ currentPassword, newUsername, newPassword }) {
  const row = statements.getAuthConfig.get()
  if (!row || !verifyPassword(currentPassword || '', row.password_hash)) {
    const err = new Error('Senha atual incorreta.')
    err.statusCode = 401
    throw err
  }

  const username = typeof newUsername === 'string' ? newUsername.trim() : ''
  if (!username) {
    const err = new Error('Novo usuário é obrigatório.')
    err.statusCode = 400
    throw err
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    const err = new Error('Nova senha precisa ter pelo menos 8 caracteres.')
    err.statusCode = 400
    throw err
  }

  statements.updateAuthConfig.run(username, hashPassword(newPassword), new Date().toISOString())
  invalidateAllSessions()
  log.info(`login changed - now user "${username}", every session invalidated`)
  logAudit('auth.credentials.change', { target: username })
}

export function verifyCurrentPassword (password) {
  const row = statements.getAuthConfig.get()
  return !!row && verifyPassword(password || '', row.password_hash)
}
