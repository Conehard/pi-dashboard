import { promises as fs } from 'fs'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('smart-health')
const STATUS_FILE = process.env.SMART_HEALTH_STATUS_FILE || '/host/pi-dashboard-status/smart-health.json'
const STALE_AFTER_MS = 3 * 60 * 60 * 1000

export async function getSmartHealthSnapshot () {
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
    log.error('smart-health.json exists but is not valid JSON', err.message)
    return { available: false, reason: 'arquivo de status inválido' }
  }

  if (!data.available) {
    return { available: false, reason: data.reason || 'smartctl indisponível no host' }
  }

  const checkedAtMs = new Date(data.checkedAt).getTime()
  const stale = !Number.isFinite(checkedAtMs) || (Date.now() - checkedAtMs) > STALE_AFTER_MS

  return {
    available: true,
    checkedAt: data.checkedAt || null,
    stale,
    devices: (Array.isArray(data.devices) ? data.devices : []).filter((d) => d.supported)
  }
}
