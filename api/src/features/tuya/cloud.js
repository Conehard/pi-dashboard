// Tuya Cloud API client - used only for setup (device discovery, local_key + DPS-schema retrieval)
// and as the LAN-unreachable fallback for control (see features/tuya/local.js). Day-to-day status
// polling never goes through here - see docs/ARCHITECTURE.md's "Tuya devices" section once that's
// written (Phase 8 of docs/plans/tuya-panel.md).
//
// Self-implemented signing over plain fetch, same call as notifications/telegram.js talking to the
// Telegram HTTP API directly - no official Tuya SDK dependency for this part.
//
// Sign algorithm: https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g
import crypto from 'crypto'
import { createLogger } from '../../lib/logger.js'
import { ActionError } from '../../lib/errors.js'
import * as messaging from './messaging.js'

const log = createLogger('tuya-cloud')
const TIMEOUT_MS = 10000
const BULK_STATUS_MAX_IDS = 20 // shared page size limit for both /v2.0/cloud/thing/batch and /v1.0/iot-03/devices/status

// The four Tuya data centers a Cloud Development project can be created in - which one is right
// depends on where the user's project/account was created, not on anything derivable from the
// credentials themselves.
export const REGIONS = {
  us: 'https://openapi.tuyaus.com',
  'us-e': 'https://openapi-ueaz.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  'eu-w': 'https://openapi-weaz.tuyaeu.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
  sg: 'https://openapi-sg.iotbing.com'
}

const EMPTY_BODY_HASH = crypto.createHash('sha256').update('').digest('hex')

function baseUrl (region) {
  const url = REGIONS[region]
  if (!url) {
    throw new ActionError('err.tuyaInvalidRegion', 400, { region, valid: Object.keys(REGIONS).join('/') })
  }
  return url
}

// Path + sorted query string - the exact string that goes both into the signature and onto the wire.
function buildSignedUrl (path, query) {
  const keys = query ? Object.keys(query).filter((k) => query[k] !== undefined) : []
  if (!keys.length) return path
  const qs = keys.sort().map((k) => `${k}=${query[k]}`).join('&')
  return `${path}?${qs}`
}

function computeSign ({ clientId, secret, accessToken, t, nonce, method, contentHash, url }) {
  // stringToSign has 4 \n-joined parts: method, content hash, signed-headers (unused here, so
  // empty - still contributes a blank line), url. The prefix (what accessToken is folded into)
  // differs for the token endpoint (no token yet) vs every other business call.
  const stringToSign = [method, contentHash, '', url].join('\n')
  const prefix = accessToken ? clientId + accessToken + t + nonce : clientId + t + nonce
  return crypto.createHmac('sha256', secret).update(prefix + stringToSign, 'utf8').digest('hex').toUpperCase()
}

async function request ({ clientId, secret, region, accessToken, method = 'GET', path, query, body }) {
  const t = Date.now().toString()
  const nonce = crypto.randomUUID()
  const bodyStr = body ? JSON.stringify(body) : ''
  const contentHash = body ? crypto.createHash('sha256').update(bodyStr).digest('hex') : EMPTY_BODY_HASH
  const url = buildSignedUrl(path, query)
  const signature = computeSign({ clientId, secret, accessToken, t, nonce, method, contentHash, url })

  const headers = {
    client_id: clientId,
    sign: signature,
    t,
    nonce,
    sign_method: 'HMAC-SHA256'
  }
  if (accessToken) headers.access_token = accessToken
  if (body) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await fetch(`${baseUrl(region)}${url}`, {
      method,
      headers,
      body: body ? bodyStr : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    throw new ActionError('err.tuyaUnreachable', 502, { detail: err.message })
  }

  const data = await res.json().catch(() => null)
  if (!data || data.success !== true) {
    const detail = data ? `${data.msg} (code ${data.code})` : `HTTP ${res.status}`
    const error = new ActionError('err.tuyaRejected', res.status >= 400 ? res.status : 502, { detail })
    error.tuyaCode = data && data.code
    throw error
  }
  return data.result
}

// One cached token per client_id - in practice only one Tuya account is ever configured at a time
// (see features/tuya/store.js's singleton config row), keyed anyway so a credential change mid-flight
// can't serve a stale token for the old client_id.
const tokenCache = new Map()
// In-flight token request per client_id, if any - see getAccessToken()'s comment below for why this
// exists. Found live: two concurrent callers (the poller's local+cloud ticks both fire at boot, and
// the cloud tick itself runs getBulkStatus/getBulkOnlineStatus via Promise.all) each independently
// requesting a fresh token when the cache was empty - two "novo access_token obtido" log lines
// milliseconds apart at every boot. Tuya appears to invalidate the previous token when a new one is
// issued for the same client_id (see docs/plans/tuya-panel.md's "Important constraint" note), so
// whichever of the two ended up NOT being the one actually cached kept getting "token invalid" (code
// 1010) on every subsequent call until the next natural refresh - up to ~2h later.
const pendingTokenRequests = new Map()

async function getAccessToken ({ clientId, secret, region }) {
  const cached = tokenCache.get(clientId)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  // Coalesce concurrent callers into the one request already in flight, instead of each firing its
  // own - the actual fix for the race described above.
  const pending = pendingTokenRequests.get(clientId)
  if (pending) return pending

  const promise = (async () => {
    try {
      const result = await request({ clientId, secret, region, method: 'GET', path: '/v1.0/token', query: { grant_type: '1' } })
      tokenCache.set(clientId, { token: result.access_token, expiresAt: Date.now() + result.expire_time * 1000 })
      log.info('novo access_token obtido, expira em', result.expire_time, 's')
      return result.access_token
    } finally {
      pendingTokenRequests.delete(clientId)
    }
  })()
  pendingTokenRequests.set(clientId, promise)
  return promise
}

async function call (config, { method, path, query, body }) {
  const accessToken = await getAccessToken(config)
  return request({ ...config, accessToken, method, path, query, body })
}

// Throws with a user-facing message if the credentials/region don't work - used by
// POST /api/tuya/config (Phase 4) to validate before saving, same idea as validateBotToken().
export async function validateCredentials (config) {
  tokenCache.delete(config.clientId) // force a real request, not a cache hit from a previous config
  await getAccessToken(config)
}

// GET /v2.0/cloud/thing/batch - up to 20 devices' `is_online` in one call. Used by the poller
// (Phase 3) to refresh online/offline for devices local.js can't probe itself (cameras, Zigbee
// sub-devices) - getBulkStatus() below covers their DPS *values*, this covers reachability.
export async function getBulkOnlineStatus (config, deviceIds) {
  if (!deviceIds.length) return {}
  if (deviceIds.length > BULK_STATUS_MAX_IDS) {
    const pages = []
    for (let i = 0; i < deviceIds.length; i += BULK_STATUS_MAX_IDS) pages.push(deviceIds.slice(i, i + BULK_STATUS_MAX_IDS))
    const results = await Promise.all(pages.map((page) => getBulkOnlineStatus(config, page)))
    return Object.assign({}, ...results)
  }
  const result = await call(config, { path: '/v2.0/cloud/thing/batch', query: { device_ids: deviceIds.join(',') } })
  const list = Array.isArray(result) ? result : (result.list || [])
  return Object.fromEntries(list.map((d) => [d.id, !!d.isOnline]))
}

// GET /v2.0/cloud/thing/device - devices linked to this project (via the linked Tuya app account),
// paginated (max page_size 20). Already includes localKey and category, so no extra per-device call
// is needed just to register a device - only getDeviceSchema() below is a separate call.
export async function listDevices (config) {
  const devices = []
  let lastId
  for (let page = 0; page < 50; page++) { // hard cap - never loop forever on an unexpected response shape
    const query = { page_size: '20' }
    if (lastId) query.last_id = lastId
    const result = await call(config, { path: '/v2.0/cloud/thing/device', query })
    const list = Array.isArray(result) ? result : (result.list || [])
    devices.push(...list.map((d) => ({
      id: d.id,
      name: d.customName || d.name,
      category: d.category,
      productId: d.productId,
      localKey: d.localKey,
      ip: d.ip || null,
      online: !!d.isOnline
    })))
    lastId = Array.isArray(result) ? null : result.last_row_key
    if (!lastId || list.length < 20) break
  }
  return devices
}

// GET /v1.0/iot-03/devices/{id}/specification - the DPS schema (functions = controllable, status =
// readable) that drives Phase 7's per-type frontend controls.
export async function getDeviceSchema (config, deviceId) {
  const result = await call(config, { path: `/v1.0/iot-03/devices/${deviceId}/specification` })
  return { category: result.category, functions: result.functions || [], status: result.status || [] }
}

// GET /v1.0/devices/{id}/sub-devices - for a Zigbee gateway device, its connected sub-devices' `node_id`
// (aka `cid`) - the identifier tuyapi's local get()/set() need to address a sub-device *through* the
// gateway's own LAN connection (its cloud device id alone isn't it - see features/tuya/local.js).
export async function getSubDevices (config, gatewayDeviceId) {
  const result = await call(config, { path: `/v1.0/devices/${gatewayDeviceId}/sub-devices` })
  const list = Array.isArray(result) ? result : (result.list || [])
  return list.map((d) => ({ id: d.id || d.device_id, nodeId: d.node_id }))
}

// POST /v1.0/iot-03/devices/{id}/commands - the LAN-unreachable fallback control path (see
// features/tuya/local.js). commands: [{ code, value }, ...]
export async function sendCommand (config, deviceId, commands) {
  await call(config, { method: 'POST', path: `/v1.0/iot-03/devices/${deviceId}/commands`, body: { commands } })
}

// Camera snapshot (Phase 13, reworked in Phase 15) - trigger a capture, then wait for its result on
// the Message Service (features/tuya/messaging.js), not by polling. The first version of this used
// `POST /v1.0/end-user/ipc/{id}/capture/allocate` + `.../resolve`, a clean poll-based API - but that
// endpoint needs an end-user OAuth token (a real Tuya app user session), not the Client ID/Secret this
// dashboard authenticates with, and consistently failed with "token invalid" for that reason -
// confirmed live, not a guess. `POST /v1.0/cameras/{id}/actions/capture` below accepts the same
// Client ID/Secret token as everything else in this file; its trade-off is that the actual image only
// ever arrives as an async push message, never as this call's own response.
export async function requestCameraSnapshot (config, deviceId) {
  const resultPromise = messaging.waitForCaptureResult(config, deviceId)
  // If the message-service connection fails fast (e.g. a bad handshake) while the capture-trigger
  // call below is still in flight, `resultPromise` rejects before anyone has awaited/caught it yet -
  // an unhandled rejection, which crashes the whole Node process by default (confirmed live: every
  // failed snapshot attempt was taking down the entire container, not just this request). This no-op
  // catch marks the promise "handled" immediately without swallowing the real rejection - the actual
  // `await`/`return` below still sees and propagates it normally.
  resultPromise.catch(() => {})
  await call(config, { method: 'POST', path: `/v1.0/cameras/${deviceId}/actions/capture` })
  return resultPromise
}

// GET /v1.0/iot-03/devices/status?device_ids=... - up to 20 devices' current DPS values (code+value
// pairs, already labeled - no numeric dp_id anywhere in it) in a single call. This is the poller's
// main source for "what's the current state" (Phase 3) - one call per tick covers the whole account
// instead of one call per device, which matters given the free tier's rate limit.
export async function getBulkStatus (config, deviceIds) {
  if (!deviceIds.length) return {}
  if (deviceIds.length > BULK_STATUS_MAX_IDS) {
    // Chop into pages rather than erroring - a 21st device shouldn't break status for the other 20.
    const pages = []
    for (let i = 0; i < deviceIds.length; i += BULK_STATUS_MAX_IDS) pages.push(deviceIds.slice(i, i + BULK_STATUS_MAX_IDS))
    const results = await Promise.all(pages.map((page) => getBulkStatus(config, page)))
    return Object.assign({}, ...results)
  }
  const result = await call(config, { path: '/v1.0/iot-03/devices/status', query: { device_ids: deviceIds.join(',') } })
  const byId = {}
  for (const device of result || []) {
    byId[device.id] = Object.fromEntries((device.status || []).map((s) => [s.code, s.value]))
  }
  return byId
}
