import { db } from '../../lib/db.js'
import { encryptSecret, decryptSecret } from '../../lib/crypto/secret-box.js'
import { createLogger } from '../../lib/logger.js'
import { logAudit } from '../audit/audit.js'

const log = createLogger('notifications-store')

export const EVENT_TYPES = [
  { key: 'job_failure', label: 'Falha de job/backup', hasThreshold: false },
  { key: 'container_down', label: 'Container caiu', hasThreshold: false },
  { key: 'disk_threshold', label: 'Disco acima do limite', hasThreshold: true },
  { key: 'uptime_down', label: 'Alvo de uptime caiu/recuperou (tela Status)', hasThreshold: false },
  { key: 'restart_pending', label: 'Restart manual pendente (registro de projeto)', hasThreshold: false }
]
const EVENT_TYPE_KEYS = new Set(EVENT_TYPES.map((e) => e.key))

db.exec(`
  CREATE TABLE IF NOT EXISTS notification_bot (
    id INTEGER PRIMARY KEY CHECK (id = 1), -- singleton row, one bot for the whole app
    token_encrypted TEXT NOT NULL,
    bot_username TEXT, -- not a secret, from Telegram's getMe, only used to display "@name"
    configured_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notification_routes (
    event_type TEXT PRIMARY KEY,
    chat_id_encrypted TEXT,      -- NULL = route not configured yet
    chat_id_preview TEXT,        -- last 4 chars only, safe to show so the user can tell chats apart
    label TEXT,                  -- optional user-given name, e.g. "Alertas críticos"
    threshold REAL,              -- only meaningful for 'disk_threshold' (% used), NULL otherwise
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`)

const statements = {
  getBot: db.prepare('SELECT * FROM notification_bot WHERE id = 1'),
  insertBot: db.prepare('INSERT INTO notification_bot (id, token_encrypted, bot_username, configured_at) VALUES (1, ?, ?, ?)'),
  updateBot: db.prepare('UPDATE notification_bot SET token_encrypted = ?, bot_username = ?, configured_at = ? WHERE id = 1'),
  deleteBot: db.prepare('DELETE FROM notification_bot WHERE id = 1'),
  getRoute: db.prepare('SELECT * FROM notification_routes WHERE event_type = ?'),
  listRoutes: db.prepare('SELECT * FROM notification_routes'),
  insertRouteIfMissing: db.prepare('INSERT OR IGNORE INTO notification_routes (event_type, enabled, updated_at) VALUES (?, 0, ?)'),
  updateRoute: db.prepare(`
    UPDATE notification_routes
    SET chat_id_encrypted = ?, chat_id_preview = ?, label = ?, threshold = ?, enabled = ?, updated_at = ?
    WHERE event_type = ?
  `)
}

function seedRoutes () {
  const now = new Date().toISOString()
  for (const type of EVENT_TYPE_KEYS) {
    statements.insertRouteIfMissing.run(type, now)
  }
}
seedRoutes()

export function isKnownEventType (type) {
  return EVENT_TYPE_KEYS.has(type)
}

export function getBotConfig () {
  return statements.getBot.get() || null
}

export function isBotConfigured () {
  return !!getBotConfig()
}

export function saveBotToken (token, botUsername) {
  const encrypted = encryptSecret(token)
  const now = new Date().toISOString()
  if (getBotConfig()) {
    statements.updateBot.run(encrypted, botUsername || null, now)
  } else {
    statements.insertBot.run(encrypted, botUsername || null, now)
  }
  log.info(`telegram bot configured${botUsername ? ` (@${botUsername})` : ''}`)
  logAudit('notifications.bot.save', { detail: botUsername ? `@${botUsername}` : null })
}

export function clearBotConfig () {
  statements.deleteBot.run()
  log.info('telegram bot config removed')
  logAudit('notifications.bot.remove')
}

export function getDecryptedBotToken () {
  const row = getBotConfig()
  if (!row) return null
  return decryptSecret(row.token_encrypted)
}

function publicRoute (row) {
  return {
    eventType: row.event_type,
    enabled: !!row.enabled,
    configured: !!row.chat_id_encrypted,
    chatIdPreview: row.chat_id_preview,
    label: row.label,
    threshold: row.threshold,
    updatedAt: row.updated_at
  }
}

export function listRoutes () {
  return statements.listRoutes.all().map(publicRoute)
}

export function getRoute (eventType) {
  const row = statements.getRoute.get(eventType)
  return row ? publicRoute(row) : null
}

export function getDecryptedChatId (eventType) {
  const row = statements.getRoute.get(eventType)
  if (!row || !row.chat_id_encrypted) return null
  return decryptSecret(row.chat_id_encrypted)
}

export function saveRoute (eventType, { chatId, label, enabled, threshold } = {}) {
  if (!isKnownEventType(eventType)) {
    const err = new Error(`Tipo de evento desconhecido: "${eventType}".`)
    err.statusCode = 400
    throw err
  }
  const existing = statements.getRoute.get(eventType)

  let chatIdEncrypted = existing ? existing.chat_id_encrypted : null
  let chatIdPreview = existing ? existing.chat_id_preview : null
  if (chatId !== undefined) {
    const trimmed = String(chatId).trim()
    if (!trimmed) {
      chatIdEncrypted = null
      chatIdPreview = null
    } else {
      chatIdEncrypted = encryptSecret(trimmed)
      chatIdPreview = trimmed.slice(-4)
    }
  }

  const finalLabel = label !== undefined ? (String(label).trim() || null) : (existing ? existing.label : null)
  const finalThreshold = threshold === undefined
    ? (existing ? existing.threshold : null)
    : (threshold === null || threshold === '' ? null : Number(threshold))
  const finalEnabled = enabled !== undefined ? !!enabled : !!(existing && existing.enabled)

  statements.updateRoute.run(
    chatIdEncrypted, chatIdPreview, finalLabel, finalThreshold, finalEnabled ? 1 : 0,
    new Date().toISOString(), eventType
  )
  logAudit('notifications.route.save', { target: eventType, detail: finalEnabled ? 'ativa' : 'inativa' })
  return getRoute(eventType)
}
