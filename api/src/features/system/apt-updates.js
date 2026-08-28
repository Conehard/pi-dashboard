import { promises as fs } from 'fs'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('system-updates')
const STATUS_FILE = process.env.APT_UPDATES_STATUS_FILE || '/host/pi-dashboard-status/apt-updates.json'
const STALE_AFTER_MS = 36 * 60 * 60 * 1000

export async function getSystemUpdatesSnapshot () {
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
    log.error('apt-updates.json exists but is not valid JSON', err.message)
    return { available: false, reason: 'arquivo de status inválido' }
  }

  const checkedAtMs = new Date(data.checkedAt).getTime()
  const stale = !Number.isFinite(checkedAtMs) || (Date.now() - checkedAtMs) > STALE_AFTER_MS

  return {
    available: true,
    checkedAt: data.checkedAt || null,
    stale,
    count: typeof data.count === 'number' ? data.count : (data.packages || []).length,
    packages: Array.isArray(data.packages) ? data.packages : []
  }
}
