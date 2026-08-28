import { randomBytes } from 'node:crypto'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('internet')

const POLL_INTERVAL_MS = Number(process.env.INTERNET_CHECK_INTERVAL_MS) || 10000
const TIMEOUT_MS = 4000
const WINDOW_SIZE = 30

const TARGETS = [
  'https://www.gstatic.com/generate_204',
  'https://1.1.1.1/cdn-cgi/trace'
]

const SPEEDTEST_INTERVAL_MS = Number(process.env.INTERNET_SPEEDTEST_INTERVAL_MS) || 15 * 60 * 1000
const SPEEDTEST_DOWNLOAD_BYTES = Number(process.env.INTERNET_SPEEDTEST_DOWNLOAD_BYTES) || 5_000_000
const SPEEDTEST_UPLOAD_BYTES = Number(process.env.INTERNET_SPEEDTEST_UPLOAD_BYTES) || 2_000_000
const SPEEDTEST_TIMEOUT_MS = 15000
const SPEEDTEST_BASE = 'https://speed.cloudflare.com'

let samples = []
let pingTimer = null

let speedtest = { available: false, downloadMbps: null, uploadMbps: null, testedAt: null }
let speedtestTimer = null
let speedtestInFlight = null

async function checkTarget (url) {
  const startedAt = performance.now()
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
  return performance.now() - startedAt
}

async function pollOnce () {
  let latencyMs = null
  for (const url of TARGETS) {
    try {
      latencyMs = await checkTarget(url)
      break
    } catch {
    }
  }

  samples.push({ at: new Date().toISOString(), success: latencyMs !== null, latencyMs })
  if (samples.length > WINDOW_SIZE) samples.shift()
}

async function measureDownloadMbps () {
  const startedAt = performance.now()
  const res = await fetch(`${SPEEDTEST_BASE}/__down?bytes=${SPEEDTEST_DOWNLOAD_BYTES}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(SPEEDTEST_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buffer = await res.arrayBuffer()
  const seconds = (performance.now() - startedAt) / 1000
  if (seconds <= 0 || buffer.byteLength === 0) return null
  return (buffer.byteLength * 8) / seconds / 1_000_000
}

async function measureUploadMbps () {
  const payload = randomBytes(SPEEDTEST_UPLOAD_BYTES)
  const startedAt = performance.now()
  const res = await fetch(`${SPEEDTEST_BASE}/__up`, {
    method: 'POST',
    body: payload,
    cache: 'no-store',
    signal: AbortSignal.timeout(SPEEDTEST_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  await res.arrayBuffer()
  const seconds = (performance.now() - startedAt) / 1000
  if (seconds <= 0) return null
  return (payload.length * 8) / seconds / 1_000_000
}

async function runSpeedtestOnce () {
  try {
    const [downloadMbps, uploadMbps] = await Promise.all([measureDownloadMbps(), measureUploadMbps()])
    speedtest = {
      available: true,
      downloadMbps: downloadMbps !== null ? Number(downloadMbps.toFixed(1)) : speedtest.downloadMbps,
      uploadMbps: uploadMbps !== null ? Number(uploadMbps.toFixed(1)) : speedtest.uploadMbps,
      testedAt: new Date().toISOString()
    }
  } catch (err) {
    log.error('speed test failed', err.message)
  }
}

export function runSpeedtest () {
  if (!speedtestInFlight) {
    speedtestInFlight = runSpeedtestOnce().finally(() => { speedtestInFlight = null })
  }
  return speedtestInFlight
}

export function startInternetPoller () {
  if (pingTimer) return

  pollOnce().catch((err) => log.error('initial connectivity check failed', err.message))
  pingTimer = setInterval(() => {
    pollOnce().catch((err) => log.error('connectivity check failed', err.message))
  }, POLL_INTERVAL_MS)
  pingTimer.unref()
  log.info(`internet ping poller started (every ${POLL_INTERVAL_MS}ms)`)

  runSpeedtest()
  speedtestTimer = setInterval(runSpeedtest, SPEEDTEST_INTERVAL_MS)
  speedtestTimer.unref()
  log.info(`internet speed test poller started (every ${SPEEDTEST_INTERVAL_MS}ms)`)
}

export function getInternetSnapshot () {
  if (samples.length === 0) return { available: false }

  const latest = samples[samples.length - 1]
  const successful = samples.filter((s) => s.success)
  const packetLossPercent = Math.round(((samples.length - successful.length) / samples.length) * 100)

  let avgLatencyMs = null
  let jitterMs = null
  if (successful.length > 0) {
    avgLatencyMs = Math.round(successful.reduce((sum, s) => sum + s.latencyMs, 0) / successful.length)
  }
  if (successful.length >= 2) {
    let diffTotal = 0
    for (let i = 1; i < successful.length; i++) {
      diffTotal += Math.abs(successful[i].latencyMs - successful[i - 1].latencyMs)
    }
    jitterMs = Math.round(diffTotal / (successful.length - 1))
  }

  return {
    available: true,
    connected: latest.success,
    latencyMs: latest.latencyMs !== null ? Math.round(latest.latencyMs) : null,
    avgLatencyMs,
    jitterMs,
    packetLossPercent,
    sampleCount: samples.length,
    recentChecks: samples.map((s) => ({ at: s.at, ok: s.success, latencyMs: s.latencyMs !== null ? Math.round(s.latencyMs) : null })),
    downloadMbps: speedtest.downloadMbps,
    uploadMbps: speedtest.uploadMbps,
    speedTestedAt: speedtest.testedAt,
    speedtestInFlight: !!speedtestInFlight
  }
}
