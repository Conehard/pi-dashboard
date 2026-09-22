// Local, internet-independent push triggers for Zigbee sub-devices (docs/plans/tuya-panel.md Phase 18).
//
// Why this exists: a Zigbee sub-device (door/window sensor, etc.) can't be *asked* for its current
// state locally - confirmed live, an on-demand get() to it through its gateway just times out, because
// it's a battery end-device asleep most of the time. What it *does* do is push a report to its gateway
// immediately on a real state change, even while otherwise asleep - confirmed live too (a real door
// open/close showed up on the gateway's local connection within ~4s, zero internet involved). So this
// module keeps a persistent local connection to a gateway (features/tuya/local.js's probe is one-shot,
// not built for this) and turns its raw pushed events into `(deviceId, code, value)` callbacks.
//
// Deliberately narrow and read-only, same spirit as local.js's own caution about DPS: the local push
// payload keys sub-devices by `cid` (a per-device Zigbee node id, NOT its cloud device id - fetched
// once via cloud.getSubDevices) and reports raw numeric DPS indices, not the cloud `code` string. There
// is no general, safe way to map an arbitrary numeric index back to a code (the exact reason this
// project never implemented local *control* either - see Phase 3). LOCAL_DPS_CODE_MAP below is only
// ever extended one category at a time, only once actually confirmed against real local push data for
// that category - not assumed from Tuya's docs or convention.
import TuyAPI from 'tuyapi'
import { createLogger } from '../../lib/logger.js'
import * as store from './store.js'
import * as cloud from './cloud.js'

const log = createLogger('tuya-gateway')
const RECONNECT_DELAY_MS = 5000

// category -> { numericDpsIndex: cloudCode }. Confirmed live 2026-09-14 for "mcs" (door/window contact
// sensors) only: its lone boolean status field (`doorcontact_state`) reports as raw dps "1". Add a new
// category here only after confirming its own raw payload the same way, not by assumption.
const LOCAL_DPS_CODE_MAP = {
  mcs: { 1: 'doorcontact_state' }
}

const connections = new Map() // gatewayDeviceId -> { client, subDeviceIndex: Map<cid, {id, category}> }
let changeListener = null

// Registered once by features/automations/engine.js - kept as a single callback (not an EventEmitter)
// since there's only ever one real subscriber in this app, same minimalism as the rest of this feature.
export function onLocalChange (fn) {
  changeListener = fn
}

async function buildSubDeviceIndex (config, gatewayDeviceId) {
  const subDevices = await cloud.getSubDevices(config, gatewayDeviceId)
  const index = new Map()
  for (const sub of subDevices) {
    if (!sub.nodeId) continue
    const device = store.getDevice(sub.id)
    if (!device) continue // not registered locally (never synced, or removed) - nothing to resolve it to
    index.set(sub.nodeId, { id: sub.id, category: device.category })
  }
  return index
}

function handleIncoming (subDeviceIndex, payload) {
  if (!payload || !payload.cid || !payload.dps) return
  const sub = subDeviceIndex.get(payload.cid)
  if (!sub) return
  const codeMap = LOCAL_DPS_CODE_MAP[sub.category]
  if (!codeMap) return
  for (const [dpsKey, value] of Object.entries(payload.dps)) {
    const code = codeMap[dpsKey]
    if (code && changeListener) changeListener(sub.id, code, value)
  }
}

function scheduleReconnect (config, gatewayDeviceId) {
  setTimeout(() => {
    if (!connections.has(gatewayDeviceId)) return // stopListening() was called meanwhile - don't revive it
    connections.delete(gatewayDeviceId)
    ensureListening(config, gatewayDeviceId).catch((err) => log.error(`reconexão com gateway ${gatewayDeviceId} falhou`, err.message))
  }, RECONNECT_DELAY_MS)
}

// Idempotent - a gateway already being listened to is a no-op, matching startTuyaPoller()-style
// "safe to call repeatedly" conventions used elsewhere in this feature.
export async function ensureListening (config, gatewayDeviceId) {
  if (connections.has(gatewayDeviceId)) return
  const gateway = store.getDevice(gatewayDeviceId)
  const localKey = store.getDecryptedLocalKey(gatewayDeviceId)
  if (!gateway || !localKey) return

  // Reserve the slot immediately (before the awaits below) so a second concurrent call for the same
  // gateway doesn't open a duplicate connection.
  connections.set(gatewayDeviceId, null)

  let subDeviceIndex
  try {
    subDeviceIndex = await buildSubDeviceIndex(config, gatewayDeviceId)
  } catch (err) {
    log.error(`falha ao listar sub-dispositivos do gateway ${gatewayDeviceId}`, err.message)
    connections.delete(gatewayDeviceId)
    return
  }
  if (!connections.has(gatewayDeviceId)) return // stopListening() raced us while we awaited above

  const client = new TuyAPI({
    id: gatewayDeviceId,
    key: localKey,
    ip: gateway.ip || undefined,
    version: gateway.protocolVersion || undefined
  })

  client.on('data', (payload) => handleIncoming(subDeviceIndex, payload))
  client.on('dp-refresh', (payload) => handleIncoming(subDeviceIndex, payload))
  client.on('error', (err) => log.error(`erro na conexão local com o gateway ${gatewayDeviceId}`, err.message))
  client.on('disconnected', () => scheduleReconnect(config, gatewayDeviceId))

  try {
    if (!gateway.ip) await client.find({ timeout: 6 })
    await client.connect()
    log.info(`escutando localmente o gateway ${gatewayDeviceId} (${subDeviceIndex.size} sub-dispositivo(s) mapeado(s))`)
  } catch (err) {
    log.error(`não foi possível conectar localmente ao gateway ${gatewayDeviceId}`, err.message)
    connections.delete(gatewayDeviceId)
    scheduleReconnect(config, gatewayDeviceId)
    return
  }

  connections.set(gatewayDeviceId, { client, subDeviceIndex })
}

export function stopListening (gatewayDeviceId) {
  const conn = connections.get(gatewayDeviceId)
  connections.delete(gatewayDeviceId) // delete first - a pending scheduleReconnect() checks this to bail out
  if (conn && conn.client) {
    try { conn.client.disconnect() } catch { /* already gone */ }
  }
}

export function activeGatewayIds () {
  return [...connections.keys()]
}

// Used by features/automations/engine.js to decide whether a rule's trigger device is even a
// candidate for local push delivery, without duplicating LOCAL_DPS_CODE_MAP's contents elsewhere.
export function isLocallyTriggerable (category) {
  return Boolean(LOCAL_DPS_CODE_MAP[category])
}
