import { promises as fs } from 'fs'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('host-schedule')
const STATUS_FILE = process.env.HOST_SCHEDULE_STATUS_FILE || '/host/pi-dashboard-status/host-schedule.json'
const STALE_AFTER_MS = 90 * 60 * 1000

const DEFAULT_SYSTEM_TIMERS = new Set([
  'apt-daily.timer',
  'apt-daily-upgrade.timer',
  'apport-autoreport.timer',
  'dpkg-db-backup.timer',
  'e2scrub_all.timer',
  'fstrim.timer',
  'fwupd-refresh.timer',
  'logrotate.timer',
  'man-db.timer',
  'motd-news.timer',
  'plocate-updatedb.timer',
  'snapd.snap-repair.timer',
  'sysstat-collect.timer',
  'sysstat-rotate.timer',
  'sysstat-summary.timer',
  'systemd-tmpfiles-clean.timer',
  'ua-timer.timer',
  'update-notifier-download.timer',
  'update-notifier-motd.timer',
  'xfs_scrub_all.timer'
])

export async function getHostScheduleSnapshot () {
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
    log.error('host-schedule.json exists but is not valid JSON', err.message)
    return { available: false, reason: 'arquivo de status inválido' }
  }

  const checkedAtMs = new Date(data.checkedAt).getTime()
  const stale = !Number.isFinite(checkedAtMs) || (Date.now() - checkedAtMs) > STALE_AFTER_MS

  return {
    available: true,
    checkedAt: data.checkedAt || null,
    stale,
    crontab: (data.crontab && data.crontab.entries) || [],
    systemdTimers: ((data.systemdTimers && data.systemdTimers.timers) || [])
      .filter((timer) => !DEFAULT_SYSTEM_TIMERS.has(timer.unit))
  }
}
