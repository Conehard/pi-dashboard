// Tuya's Message Service client (a customized Apache Pulsar, exposed over plain WebSocket) - needed
// for camera snapshots (docs/plans/tuya-panel.md Phase 13/15): triggering a capture
// (`POST /v1.0/cameras/{id}/actions/capture`, cloud.js) only returns a command-record id - the actual
// image is delivered asynchronously as a push message on this stream, there's no polling endpoint for
// it (the `/v1.0/end-user/ipc/.../capture/allocate+resolve` polling flow this project tried first
// needs an end-user OAuth token, not the Client ID/Secret this dashboard authenticates with - a real,
// confirmed dead end, not a guess).
//
// Self-implemented against Tuya's own official Node.js SDK, not adopted as a dependency: that SDK
// isn't published to npm or a maintained public repo - developer.tuya.com's docs link straight to a
// downloadable ZIP. Its actual logic is small (WebSocket connect with two auth headers, AES-decrypt
// each message, JSON-ack by message id) - vendoring just that logic here, using `ws` + Node's built-in
// `crypto` (no need for the original's `crypto-js`), is more maintainable than depending on an
// unpublished third-party artifact for ~100 lines of protocol handling.
import crypto from 'crypto'
import WebSocket from 'ws'
import { ActionError } from '../../lib/errors.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('tuya-messaging')

// Only 4 data centers have a documented message-service endpoint (unlike the 7 REST API regions this
// project otherwise supports) - the extra ones this dashboard added for the REST API (us-e/eu-w/sg)
// share a message-service endpoint with their base region, except sg, which has none documented at all.
const REGION_WS_URLS = {
  us: 'wss://mqe.tuyaus.com:8285/',
  'us-e': 'wss://mqe.tuyaus.com:8285/',
  eu: 'wss://mqe.tuyaeu.com:8285/',
  'eu-w': 'wss://mqe.tuyaeu.com:8285/',
  cn: 'wss://mqe.tuyacn.com:8285/',
  in: 'wss://mqe.tuyain.com:8285/'
}

function buildTopicUrl (region, accessId) {
  const base = REGION_WS_URLS[region]
  if (!base) return null
  return `${base}ws/v2/consumer/persistent/${accessId}/out/event/${accessId}-sub?subscriptionType=Failover&ackTimeoutMillis=30000`
}

// Matches the official SDK's buildPassword() exactly (see docs/plans/tuya-panel.md's note on where
// this was sourced from) - accessId/accessKey here are the same Client ID/Secret already stored for
// the REST API, not a separate credential pair.
function buildPassword (accessId, accessKey) {
  const keyHash = crypto.createHash('md5').update(accessKey).digest('hex')
  return crypto.createHash('md5').update(accessId + keyHash).digest('hex').slice(8, 24)
}

function decryptEcb (data, accessKey) {
  const key = Buffer.from(accessKey.slice(8, 24), 'utf8')
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}

function decryptGcm (data, accessKey) {
  const key = Buffer.from(accessKey.slice(8, 24), 'utf8')
  const raw = Buffer.from(data, 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const ciphertext = raw.subarray(12, raw.length - 16)
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}

function decodeMessage (raw, accessKey) {
  const { payload, properties, messageId } = JSON.parse(raw.toString())
  const outer = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
  const decryptFn = properties && properties.em === 'aes_gcm' ? decryptGcm : decryptEcb
  outer.data = decryptFn(outer.data, accessKey)
  return { messageId, decoded: outer }
}

// Best-effort image-URL extraction - the exact payload shape for a capture-completed message isn't
// fully documented publicly (checked developer.tuya.com's message-type reference - it lists the
// generic device property/status/action-result message types but not this specific one by field name).
// Checks several plausible field names/paths rather than assuming one; logs the full raw message
// either way so a real capture tells us exactly what to match on if every guess here misses.
function extractImageUrl (decoded, deviceId) {
  const data = decoded && decoded.data
  if (!data) return null
  if (data.devId && data.devId !== deviceId) return null // a message for some other device on the account
  const candidates = [
    data.dataUrl, data.imageUrl, data.url, data.picUrl,
    data.bizData && data.bizData.dataUrl,
    data.bizData && data.bizData.imageUrl,
    data.bizData && data.bizData.url
  ]
  return candidates.find((v) => typeof v === 'string' && v.startsWith('http')) || null
}

// On-demand only - opens a connection just long enough to catch the one message this specific capture
// produces, then closes. No persistent/always-on connection (matches the frontend's own "on-demand,
// not a background poll" rule for snapshots - see docs/plans/tuya-panel.md Phase 13).
export function waitForCaptureResult (config, deviceId, timeoutMs = 20_000) {
  const topicUrl = buildTopicUrl(config.region, config.clientId)
  if (!topicUrl) {
    return Promise.reject(new ActionError('err.tuyaSnapshotRegionUnsupported', 400, { region: config.region }))
  }

  return new Promise((resolve, reject) => {
    const password = buildPassword(config.clientId, config.secret)
    const socket = new WebSocket(topicUrl, { rejectUnauthorized: false, headers: { username: config.clientId, password } })

    let settled = false
    const timer = setTimeout(() => finish(new ActionError('err.tuyaSnapshotTimeout', 504)), timeoutMs)

    function finish (err, result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closing/closed */ }
      if (err) reject(err)
      else resolve(result)
    }

    socket.on('ping', () => { try { socket.pong(config.clientId) } catch { /* socket already gone */ } })

    socket.on('message', (raw) => {
      try {
        const { messageId, decoded } = decodeMessage(raw, config.secret)
        if (messageId) socket.send(JSON.stringify({ messageId })) // ack, same as the official SDK
        log.info(`mensagem recebida do serviço da Tuya (snapshot ${deviceId}): ${JSON.stringify(decoded).slice(0, 500)}`)
        const imageUrl = extractImageUrl(decoded, deviceId)
        if (imageUrl) finish(null, imageUrl)
      } catch (err) {
        log.error('falha ao processar mensagem do serviço da Tuya', err.message)
      }
    })

    socket.on('error', (err) => finish(new ActionError('err.tuyaSnapshotFailed', 502, { detail: err.message })))
    socket.on('close', () => finish(new ActionError('err.tuyaSnapshotTimeout', 504)))
  })
}
