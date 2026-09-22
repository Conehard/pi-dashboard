// Background poller - two independent cadences into one in-memory cache, same shape as
// features/system/miner.js/processes.js's own pollers.
//
// - Local tick (fast, ~20s): features/tuya/local.js's connect-only probe, for devices that actually
//   speak the LAN protocol (has a local_key, not a camera). Owns online/ip/protocol_version for those.
// - Cloud tick (slower, ~60s): one GET /v1.0/iot-03/devices/status call for every registered device's
//   DPS values (labeled by code, always - see local.js's header comment for why there's no local
//   equivalent of this), plus one GET /v2.0/cloud/thing/batch call for is_online - used as the online
//   signal ONLY for devices the local tick can't reach itself (cameras, Zigbee sub-devices).
//
// GET /api/tuya/devices (routes/tuya.routes.js, Phase 4) merges store.listDevices() with
// getCachedDps(id) from here - the store holds identity/schema/runtime-online, this module holds the
// live DPS values (which change far more often than anything worth persisting to SQLite).
import { createLogger } from '../../lib/logger.js'
import { ActionError } from '../../lib/errors.js'
import * as store from './store.js'
import * as cloud from './cloud.js'
import { probe } from './local.js'

const log = createLogger('tuya-poller')
const LOCAL_TICK_MS = Number(process.env.TUYA_LOCAL_POLL_INTERVAL_MS) || 20_000
// Dropped from 60s to 30s after real usage (docs/plans/tuya-panel.md Phase 10) - a Zigbee sub-device's
// value can take a while to reach here at all (sensor → mesh → gateway → Tuya cloud → this tick), so
// the tick itself shouldn't add more than it has to. Still one cheap bulk call regardless of device
// count, nowhere near the free tier's rate limit at any sane account size.
const CLOUD_TICK_MS = Number(process.env.TUYA_CLOUD_POLL_INTERVAL_MS) || 30_000
const MANUAL_REFRESH_COOLDOWN_MS = 5000

const dpsCache = new Map() // deviceId -> { values: { [code]: value }, updatedAt }
const lastManualRefresh = new Map() // deviceId -> timestamp, see refreshDeviceNow()
let localTimer = null
let cloudTimer = null
let localTickRunning = false
let cloudTickRunning = false

// Shared by the local tick and refreshDeviceNow() (Phase 12) - one device's worth of local probing.
async function applyLocalProbe (device) {
  const localKey = store.getDecryptedLocalKey(device.id)
  let result
  try {
    result = await probe(device, localKey)
  } catch (err) {
    log.error(`probe local falhou pra ${device.id}`, err.message)
    return
  }
  if (!result.supported) return // this device's online flag belongs entirely to the cloud tick
  store.updateDeviceRuntime(device.id, {
    online: result.online,
    ip: result.ip,
    protocolVersion: result.protocolVersion
  })
}

async function runLocalTick () {
  if (localTickRunning) return // a slow probe (offline device, full find() timeout) can outlast one tick
  localTickRunning = true
  try {
    if (!store.isConfigured()) return
    const devices = store.listDevices({ includeHidden: true })
    await Promise.all(devices.map(applyLocalProbe))
  } finally {
    localTickRunning = false
  }
}

// Shared by the cloud tick and refreshDeviceNow() (Phase 12) - `devices` can be the whole registered
// list (the tick) or a single one (a manual refresh), the logic is identical either way.
async function applyCloudStatus (config, devices) {
  if (!devices.length) return
  const ids = devices.map((d) => d.id)
  const [statusById, onlineById] = await Promise.all([
    cloud.getBulkStatus(config, ids).catch((err) => { log.error('getBulkStatus falhou', err.message); return {} }),
    cloud.getBulkOnlineStatus(config, ids).catch((err) => { log.error('getBulkOnlineStatus falhou', err.message); return {} })
  ])

  const now = new Date().toISOString()
  for (const device of devices) {
    if (statusById[device.id] !== undefined) {
      dpsCache.set(device.id, { values: statusById[device.id], updatedAt: now })
    }
    // Cameras and Zigbee sub-devices never get probed locally (see applyLocalProbe) - this cloud read
    // is the only online signal they ever get.
    const localCapable = device.hasLocalKey && device.category !== 'sp'
    if (!localCapable && onlineById[device.id] !== undefined) {
      store.updateDeviceRuntime(device.id, { online: onlineById[device.id] })
    }
  }
}

async function runCloudTick () {
  if (cloudTickRunning) return
  cloudTickRunning = true
  try {
    const config = store.getDecryptedConfig()
    if (!config) return
    await applyCloudStatus(config, store.listDevices({ includeHidden: true }))
  } finally {
    cloudTickRunning = false
  }
}

export function getCachedDps (deviceId) {
  return dpsCache.get(deviceId) || null
}

// Phase 12 - an on-demand, single-device version of what the two ticks above already do on a timer.
// Cooldown-limited so a user mashing the "refresh" button can't spam Tuya's API (mirrors how
// features/system/internet.js's speedtest button coalesces into whatever run is already in flight).
export async function refreshDeviceNow (deviceId) {
  const last = lastManualRefresh.get(deviceId)
  if (last && Date.now() - last < MANUAL_REFRESH_COOLDOWN_MS) {
    throw new ActionError('err.tuyaRefreshTooSoon', 429)
  }
  lastManualRefresh.set(deviceId, Date.now())

  const device = store.getDevice(deviceId)
  if (!device) return null

  const config = store.getDecryptedConfig()
  await Promise.all([
    applyLocalProbe(device),
    config ? applyCloudStatus(config, [device]) : Promise.resolve()
  ])
  return store.getDevice(deviceId)
}

export function startTuyaPoller () {
  if (localTimer || cloudTimer) return
  localTimer = setInterval(() => { runLocalTick().catch((err) => log.error('tick local falhou', err.message)) }, LOCAL_TICK_MS)
  cloudTimer = setInterval(() => { runCloudTick().catch((err) => log.error('tick nuvem falhou', err.message)) }, CLOUD_TICK_MS)
  // Kick off an immediate first read of each kind instead of waiting a full interval after boot.
  runLocalTick().catch((err) => log.error('tick local inicial falhou', err.message))
  runCloudTick().catch((err) => log.error('tick nuvem inicial falhou', err.message))
  log.info(`poller Tuya iniciado (local a cada ${LOCAL_TICK_MS}ms, nuvem a cada ${CLOUD_TICK_MS}ms)`)
}
