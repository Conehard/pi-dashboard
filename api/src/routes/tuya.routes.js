import { Router } from 'express'
import { requireAuth } from '../features/auth/sessions.js'
import { verifyCurrentPassword } from '../features/auth/credentials.js'
import { asyncHandler } from '../middleware/async-handler.js'
import { createLogger } from '../lib/logger.js'
import { t } from '../lib/i18n.js'
import { ActionError } from '../lib/errors.js'
import { logAudit } from '../features/audit/audit.js'
import * as store from '../features/tuya/store.js'
import * as cloud from '../features/tuya/cloud.js'
import { getCachedDps, refreshDeviceNow } from '../features/tuya/poller.js'

const log = createLogger('tuya-routes')
const router = Router()
router.use(requireAuth)

function requireConfig () {
  const config = store.getDecryptedConfig()
  if (!config) {
    throw new ActionError('err.tuyaNotConfigured', 400)
  }
  return config
}

function requireDevice (id) {
  const device = store.getDevice(id)
  if (!device) {
    throw new ActionError('err.tuyaDeviceNotFound', 404, { id })
  }
  return device
}

// Accepts either a single { code, value } or { commands: [{ code, value }, ...] } - see
// docs/plans/tuya-panel.md Phase 4: one generic endpoint for every DPS, not one route per action,
// since what a device can do is entirely defined by its own schema, not by anything this API assumes.
function normalizeCommands (body) {
  const raw = Array.isArray(body?.commands)
    ? body.commands
    : (body && body.code !== undefined ? [{ code: body.code, value: body.value }] : [])
  if (!raw.length || raw.some((c) => typeof c.code !== 'string' || !c.code.trim())) {
    throw new ActionError('err.tuyaCommandRequired', 400)
  }
  return raw.map((c) => ({ code: c.code, value: c.value }))
}

function withDps (device) {
  const cached = getCachedDps(device.id)
  return { ...device, dps: cached ? cached.values : {}, dpsUpdatedAt: cached ? cached.updatedAt : null }
}

router.get('/status', (req, res) => {
  const summary = store.getConfigSummary()
  res.json({
    ok: true,
    configured: !!summary,
    region: summary ? summary.region : null,
    clientIdPreview: summary ? summary.clientIdPreview : null,
    configuredAt: summary ? summary.configuredAt : null,
    regions: Object.keys(cloud.REGIONS), // so the frontend's region picker never has to hardcode the list
    deviceCount: store.listDevices({ includeHidden: true }).length
  })
})

router.post('/config', asyncHandler(async (req, res) => {
  // Unlike the Telegram bot token (DELETE /config below still asks), saving/changing these doesn't
  // require the current password again - the session's already authenticated, and there's only one
  // user on this dashboard, so the extra confirmation is just friction with no real second factor
  // behind it here. Kept on DELETE since unregistering the whole account + every device is the more
  // destructive side.
  const { clientId, clientSecret, region } = req.body || {}
  if (typeof clientId !== 'string' || !clientId.trim() || typeof clientSecret !== 'string' || !clientSecret.trim()) {
    res.status(400).json({ ok: false, error: t(req.lang, 'err.tuyaClientIdSecretRequired') })
    return
  }
  if (!cloud.REGIONS[region]) {
    res.status(400).json({ ok: false, error: t(req.lang, 'err.tuyaRegionRequired') })
    return
  }
  const trimmedConfig = { clientId: clientId.trim(), secret: clientSecret.trim(), region }
  await cloud.validateCredentials(trimmedConfig) // throws (err.tuyaUnreachable/err.tuyaRejected) if these don't actually work
  store.saveConfig({ clientId: trimmedConfig.clientId, clientSecret: trimmedConfig.secret, region })
  res.json({ ok: true, config: store.getConfigSummary() })
}))

router.delete('/config', (req, res) => {
  const { currentPassword } = req.body || {}
  if (!verifyCurrentPassword(currentPassword)) {
    res.status(401).json({ ok: false, error: t(req.lang, 'err.currentPasswordIncorrect') })
    return
  }
  store.clearConfig()
  res.json({ ok: true })
})

// Runs the full discovery flow: list devices under the linked app account, fetch each one's DPS
// schema, upsert into tuya_devices. A single device's schema call failing doesn't abort the whole
// sync - it's still registered (with an empty schema, generic-fallback-only in Phase 7's UI) rather
// than silently missing, and gets a real schema on the next sync.
router.post('/sync', asyncHandler(async (req, res) => {
  const config = requireConfig()
  const remoteDevices = await cloud.listDevices(config)
  const existingIds = new Set(store.listDevices({ includeHidden: true }).map((d) => d.id))

  let added = 0
  let updated = 0
  for (const device of remoteDevices) {
    let schema = { functions: [], status: [] }
    try {
      schema = await cloud.getDeviceSchema(config, device.id)
    } catch (err) {
      log.error(`falha ao buscar schema de ${device.id} (${device.name}) durante sync, registrando sem schema`, err.message)
    }
    store.upsertDeviceFromCloud({
      id: device.id,
      name: device.name,
      category: device.category,
      productId: device.productId,
      localKey: device.localKey || null,
      schema
    })
    if (existingIds.has(device.id)) updated++
    else added++
  }

  logAudit('tuya.sync', { detail: `${added} new, ${updated} updated, ${remoteDevices.length} total` })
  res.json({ ok: true, added, updated, total: remoteDevices.length })
}))

router.get('/devices', (req, res) => {
  const includeHidden = req.query.includeHidden === '1'
  res.json({ ok: true, devices: store.listDevices({ includeHidden }).map(withDps) })
})

// Phase 12 - forces one immediate read for just this device (local probe + cloud status), instead of
// waiting for the next background tick. Cooldown-limited inside refreshDeviceNow() itself.
router.post('/devices/:id/refresh', asyncHandler(async (req, res) => {
  requireDevice(req.params.id)
  const device = await refreshDeviceNow(req.params.id)
  res.json({ ok: true, device: withDps(device) })
}))

// Phase 13 - on-demand only (never auto-polled, see cloud.js's comment on why). Only meaningful for
// camera ('sp') devices - anything else 400s rather than silently trying and failing.
router.post('/devices/:id/snapshot', asyncHandler(async (req, res) => {
  const config = requireConfig()
  const device = requireDevice(req.params.id)
  if (device.category !== 'sp') {
    res.status(400).json({ ok: false, error: t(req.lang, 'err.tuyaNotACamera') })
    return
  }
  const imageUrl = await cloud.requestCameraSnapshot(config, device.id)
  logAudit('tuya.device.snapshot', { target: device.id })
  res.json({ ok: true, imageUrl })
}))

router.post('/devices/:id/command', asyncHandler(async (req, res) => {
  const config = requireConfig()
  const device = requireDevice(req.params.id)
  const commands = normalizeCommands(req.body)
  await cloud.sendCommand(config, device.id, commands)
  logAudit('tuya.device.command', { target: device.id, detail: JSON.stringify(commands) })
  res.json({ ok: true })
}))

router.put('/devices/:id', asyncHandler(async (req, res) => {
  const device = requireDevice(req.params.id)
  const { name, hidden } = req.body || {}
  if (name !== undefined) store.renameDevice(device.id, name)
  if (hidden !== undefined) store.setDeviceHidden(device.id, !!hidden)
  res.json({ ok: true, device: withDps(store.getDevice(device.id)) })
}))

router.delete('/devices/:id', asyncHandler(async (req, res) => {
  const device = requireDevice(req.params.id)
  store.removeDevice(device.id)
  res.json({ ok: true })
}))

export default router
