import { createLogger } from '../../lib/logger.js'

const log = createLogger('cloudflared-status')
const METRICS_URL = process.env.CLOUDFLARED_METRICS_URL || 'http://cloudflared:20241/metrics'
const TIMEOUT_MS = 3000

function extractGauge (text, metricName) {
  const match = text.match(new RegExp(`^${metricName}\\s+(\\d+(?:\\.\\d+)?)`, 'm'))
  return match ? Number(match[1]) : null
}

export async function getCloudflaredSnapshot () {
  let res
  try {
    res = await fetch(METRICS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    return { available: false }
  }

  if (!res.ok) return { available: false }

  const text = await res.text()
  const haConnections = extractGauge(text, 'cloudflared_tunnel_ha_connections')
  const totalRequests = extractGauge(text, 'cloudflared_tunnel_total_requests')

  if (haConnections === null) {
    log.error('cloudflared metrics reachable but ha_connections gauge missing - format may have changed')
    return { available: false }
  }

  return {
    available: true,
    connected: haConnections > 0,
    haConnections,
    totalRequests
  }
}
