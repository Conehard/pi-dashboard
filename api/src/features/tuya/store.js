import { db } from '../../lib/db.js'
import { encryptSecret, decryptSecret } from '../../lib/crypto/secret-box.js'
import { createLogger } from '../../lib/logger.js'
import { ActionError } from '../../lib/errors.js'
import { logAudit } from '../audit/audit.js'

const log = createLogger('tuya-store')

db.exec(`
  CREATE TABLE IF NOT EXISTS tuya_config (
    id INTEGER PRIMARY KEY CHECK (id = 1), -- singleton row, one Tuya account for the whole app
    client_id TEXT NOT NULL,
    client_secret_encrypted TEXT NOT NULL,
    region TEXT NOT NULL, -- key into cloud.js's REGIONS ('us', 'eu', ...)
    configured_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tuya_devices (
    id TEXT PRIMARY KEY, -- the Tuya device id itself, not a local autoincrement
    name TEXT NOT NULL,
    category TEXT,
    product_id TEXT,
    local_key_encrypted TEXT, -- NULL for Zigbee sub-devices, which have no LAN key of their own
    ip TEXT,                  -- last known LAN address (from cloud discovery or UDP probing), nullable
    protocol_version TEXT,    -- '3.3'/'3.4'/'3.5' - filled in by local.js once first probed, nullable
    dps_schema TEXT,          -- JSON cache of cloud.getDeviceSchema()'s { functions, status }
    online INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`)

const statements = {
  getConfig: db.prepare('SELECT * FROM tuya_config WHERE id = 1'),
  insertConfig: db.prepare('INSERT INTO tuya_config (id, client_id, client_secret_encrypted, region, configured_at) VALUES (1, ?, ?, ?, ?)'),
  updateConfig: db.prepare('UPDATE tuya_config SET client_id = ?, client_secret_encrypted = ?, region = ?, configured_at = ? WHERE id = 1'),
  deleteConfig: db.prepare('DELETE FROM tuya_config WHERE id = 1'),

  getDevice: db.prepare('SELECT * FROM tuya_devices WHERE id = ?'),
  listDevices: db.prepare('SELECT * FROM tuya_devices ORDER BY name COLLATE NOCASE'),
  deleteDevice: db.prepare('DELETE FROM tuya_devices WHERE id = ?'),
  deleteAllDevices: db.prepare('DELETE FROM tuya_devices'),
  upsertDevice: db.prepare(`
    INSERT INTO tuya_devices (id, name, category, product_id, local_key_encrypted, ip, dps_schema, online, last_seen_at, created_at, updated_at)
    VALUES (@id, @name, @category, @productId, @localKeyEncrypted, @ip, @dpsSchema, @online, @lastSeenAt, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      -- name/category/product/local_key/schema come from Tuya on every sync - always refresh them.
      -- ip/protocol_version/online/last_seen_at are runtime state owned by the poller (features/tuya/local.js)
      -- and must NOT be clobbered by a sync running concurrently with it.
      name = excluded.name,
      category = excluded.category,
      product_id = excluded.product_id,
      local_key_encrypted = excluded.local_key_encrypted,
      dps_schema = excluded.dps_schema,
      updated_at = excluded.updated_at
  `),
  updateRuntime: db.prepare(`
    UPDATE tuya_devices SET online = ?, ip = COALESCE(?, ip), protocol_version = COALESCE(?, protocol_version), last_seen_at = ?, updated_at = ?
    WHERE id = ?
  `),
  renameDevice: db.prepare('UPDATE tuya_devices SET name = ?, updated_at = ? WHERE id = ?'),
  setHidden: db.prepare('UPDATE tuya_devices SET hidden = ?, updated_at = ? WHERE id = ?')
}

// --- Account config (Client ID/Secret/region) ---

export function isConfigured () {
  return !!statements.getConfig.get()
}

// Public shape - never includes the secret, same rule as notifications' bot token.
export function getConfigSummary () {
  const row = statements.getConfig.get()
  if (!row) return null
  return {
    region: row.region,
    clientIdPreview: `${row.client_id.slice(0, 4)}…${row.client_id.slice(-4)}`,
    configuredAt: row.configured_at
  }
}

// Internal - the decrypted credentials, for cloud.js calls. Never sent to the browser.
export function getDecryptedConfig () {
  const row = statements.getConfig.get()
  if (!row) return null
  const secret = decryptSecret(row.client_secret_encrypted)
  if (!secret) return null // APP_ENCRYPTION_KEY missing/changed - same fail-safe as notifications
  return { clientId: row.client_id, secret, region: row.region }
}

export function saveConfig ({ clientId, clientSecret, region }) {
  const encrypted = encryptSecret(clientSecret)
  const now = new Date().toISOString()
  if (statements.getConfig.get()) {
    statements.updateConfig.run(clientId, encrypted, region, now)
  } else {
    statements.insertConfig.run(clientId, encrypted, region, now)
  }
  log.info(`conta Tuya configurada (região ${region})`)
  logAudit('tuya.config.save', { detail: region })
}

// Also wipes every registered device - their local_keys/schemas belong to the account being removed,
// keeping them around would just be orphaned, silently-stale data (see docs/plans/tuya-panel.md Phase 4).
export function clearConfig () {
  statements.deleteConfig.run()
  const count = statements.deleteAllDevices.run().changes
  log.info(`conta Tuya removida (${count} dispositivo(s) desregistrado(s) junto)`)
  logAudit('tuya.config.remove', { detail: `${count} dispositivo(s)` })
}

// --- Devices ---

function publicDevice (row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    productId: row.product_id,
    hasLocalKey: !!row.local_key_encrypted,
    ip: row.ip,
    protocolVersion: row.protocol_version,
    schema: row.dps_schema ? JSON.parse(row.dps_schema) : { functions: [], status: [] },
    online: !!row.online,
    lastSeenAt: row.last_seen_at,
    hidden: !!row.hidden
  }
}

export function listDevices ({ includeHidden = false } = {}) {
  const rows = statements.listDevices.all()
  return rows.filter((r) => includeHidden || !r.hidden).map(publicDevice)
}

export function getDevice (id) {
  const row = statements.getDevice.get(id)
  return row ? publicDevice(row) : null
}

// Internal - decrypted local_key for features/tuya/local.js. Null if this device has none (Zigbee
// sub-device - see docs/plans/tuya-panel.md's Phase 1 notes) or the encryption key is unavailable.
export function getDecryptedLocalKey (id) {
  const row = statements.getDevice.get(id)
  if (!row || !row.local_key_encrypted) return null
  return decryptSecret(row.local_key_encrypted)
}

// Called by features/tuya/sync.js (Phase 4) after a cloud.listDevices()+getDeviceSchema() run.
export function upsertDeviceFromCloud ({ id, name, category, productId, localKey, schema }) {
  statements.upsertDevice.run({
    id,
    name,
    category: category || null,
    productId: productId || null,
    localKeyEncrypted: localKey ? encryptSecret(localKey) : null,
    ip: null, // deliberately not seeded from the cloud snapshot's IP - see Phase 3, only local UDP discovery is trusted
    dpsSchema: schema ? JSON.stringify(schema) : null,
    online: 0,
    lastSeenAt: null,
    now: new Date().toISOString()
  })
}

// Called by the background poller / LAN discovery (Phase 3) - never touches name/schema/local_key.
export function updateDeviceRuntime (id, { online, ip, protocolVersion }) {
  statements.updateRuntime.run(online ? 1 : 0, ip || null, protocolVersion || null, new Date().toISOString(), new Date().toISOString(), id)
}

export function renameDevice (id, name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) {
    // reuses the same key scheduler.routes.js already uses
    throw new ActionError('err.nameRequired', 400)
  }
  statements.renameDevice.run(trimmed, new Date().toISOString(), id)
  logAudit('tuya.device.rename', { target: id, detail: trimmed })
}

export function setDeviceHidden (id, hidden) {
  statements.setHidden.run(hidden ? 1 : 0, new Date().toISOString(), id)
  logAudit(hidden ? 'tuya.device.hide' : 'tuya.device.unhide', { target: id })
}

export function removeDevice (id) {
  statements.deleteDevice.run(id)
  log.info(`dispositivo ${id} desregistrado (apenas local - conta Tuya não é afetada)`)
  logAudit('tuya.device.remove', { target: id })
}
