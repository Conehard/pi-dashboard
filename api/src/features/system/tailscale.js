import { promises as fs } from 'fs'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('tailscale-status')
const STATUS_FILE = process.env.TAILSCALE_STATUS_FILE || '/host/pi-dashboard-status/tailscale-status.json'
const STALE_AFTER_MS = 30 * 60 * 1000

export async function getTailscaleSnapshot () {
  let raw
  try {
    raw = await fs.readFile(STATUS_FILE, 'utf8')
  } catch {
    return { available: false, reason: 'ainda sem nenhuma checagem registrada' }
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    log.error('tailscale-status.json exists but is not valid JSON', err.message)
    return { available: false, reason: 'arquivo de status inválido' }
  }

  if (data.available === false) {
    return { available: false, reason: data.error || 'tailscale indisponível no host' }
  }

  const checkedAtMs = new Date(data.checkedAt).getTime()
  const stale = !Number.isFinite(checkedAtMs) || (Date.now() - checkedAtMs) > STALE_AFTER_MS

  return {
    available: true,
    checkedAt: data.checkedAt || null,
    stale,
    connected: data.backendState === 'Running',
    backendState: data.backendState || null,
    selfHostname: data.selfHostname || null,
    selfIps: Array.isArray(data.selfIps) ? data.selfIps : [],
    peerCount: typeof data.peerCount === 'number' ? data.peerCount : 0,
    peerOnlineCount: typeof data.peerOnlineCount === 'number' ? data.peerOnlineCount : 0,
    exitNodeActive: !!data.exitNodeActive
  }
}
