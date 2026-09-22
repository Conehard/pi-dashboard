// Local LAN presence/reachability probing - deliberately READ-ONLY (no set()/control here).
//
// Why: Tuya's local DPS protocol addresses every data point by a numeric index (e.g. "1", "9"), but
// the Cloud API never returns that number for this account - confirmed live (GET /v1.0/devices/{id}'s
// `status` array only ever has {code, value}, no dp_id) - and tinytuya's own docs say the real mapping
// only becomes available after manually enabling "DP Instruction" mode per-device in the Tuya console,
// which itself takes 12-24h to propagate and doesn't cover every product either. Guessing the index
// risks tripping the wrong function on a physical device. See docs/plans/tuya-panel.md Phase 3.
//
// So: every real control command goes through features/tuya/cloud.js's sendCommand() instead, which
// addresses DPS by `code` and is always correct. This module's only job is answering "is this device
// alive on the LAN right now" (fast, free, works without internet) - actual DPS *values* come from
// cloud.js's getBulkStatus() (features/tuya/poller.js calls both, see there for how they combine).
import TuyAPI from 'tuyapi'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('tuya-local')
const FIND_TIMEOUT_S = 6
const FIND_TIMEOUT_MS = (FIND_TIMEOUT_S + 2) * 1000 // a bit more than tuyapi's own internal timeout
const CONNECT_TIMEOUT_MS = 6000

// Tuya's smart-camera category never answers the classic port-6666/6668 DPS protocol - confirmed live
// (find() just times out for every camera on this account, every time), it's a different, video-focused
// protocol entirely. Not worth probing - it would just burn FIND_TIMEOUT_S doing nothing every cycle.
const NO_LOCAL_PROTOCOL_CATEGORIES = new Set(['sp'])

function withTimeout (promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Returns { supported, online, ip, protocolVersion }. `supported: false` (category never has a local
// protocol, or no local_key - e.g. a Zigbee sub-device, see store.js's Phase 1 notes) means "don't ask
// again for this device", distinct from `online: false` (asked, got no answer this time).
export async function probe (device, localKey) {
  if (!localKey || NO_LOCAL_PROTOCOL_CATEGORIES.has(device.category)) {
    return { supported: false, online: false, ip: null, protocolVersion: null }
  }

  const client = new TuyAPI({
    id: device.id,
    key: localKey,
    ip: device.ip || undefined,
    version: device.protocolVersion || undefined
  })

  async function tryConnect () {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'connect')
    return { supported: true, online: true, ip: client.device.ip, protocolVersion: String(client.device.version) }
  }

  try {
    if (device.ip) {
      // Fast path: we already know where it is - just connect directly, no UDP broadcast wait.
      try {
        return await tryConnect()
      } catch (err) {
        // Cached IP might be stale (DHCP lease renewed) - fall through to a fresh find() below
        // instead of giving up, same as a first-ever probe.
        log.info(`${device.id}: connect direto em ${device.ip} falhou (${err.message}), tentando find()`)
      }
    }
    const found = await withTimeout(client.find({ timeout: FIND_TIMEOUT_S }), FIND_TIMEOUT_MS, 'find')
    if (!found) return { supported: true, online: false, ip: null, protocolVersion: null }
    return await tryConnect()
  } catch (err) {
    return { supported: true, online: false, ip: null, protocolVersion: null }
  } finally {
    try { client.disconnect() } catch { /* already gone, nothing to clean up */ }
  }
}
