import fs from 'node:fs/promises'
import os from 'node:os'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('system')

const HOST_PROC = '/host/proc'
const HOST_SYS = '/host/sys'
const HOST_ETC = '/host/etc'

let lastCpuSample = null

async function readFileSafe (path) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch (err) {
    return null
  }
}

function parseCpuLine (statText) {
  const line = statText.split('\n').find(l => l.startsWith('cpu '))
  if (!line) return null

  const parts = line.trim().split(/\s+/).slice(1).map(Number)
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts
  if ([user, nice, system, idle].some(Number.isNaN)) return null

  const idleTotal = idle + iowait
  const total = user + nice + system + idle + iowait + irq + softirq + steal
  return { idleTotal, total }
}

export async function getCpuUsagePercent () {
  const text = await readFileSafe(`${HOST_PROC}/stat`)
  if (!text) return null

  const sample = parseCpuLine(text)
  if (!sample) return null

  if (!lastCpuSample) {
    lastCpuSample = sample
    return null
  }

  const totalDelta = sample.total - lastCpuSample.total
  const idleDelta = sample.idleTotal - lastCpuSample.idleTotal
  lastCpuSample = sample

  if (totalDelta <= 0) return null
  return Number(((1 - idleDelta / totalDelta) * 100).toFixed(1))
}

export function getCpuCoreCount () {
  try {
    return os.cpus().length
  } catch {
    return null
  }
}

export async function getTemperatureCelsius () {
  const text = await readFileSafe(`${HOST_SYS}/class/thermal/thermal_zone0/temp`)
  if (!text) return null

  const raw = Number(text.trim())
  if (Number.isNaN(raw)) return null
  return Number((raw / 1000).toFixed(1))
}

export async function getMemoryInfo () {
  const text = await readFileSafe(`${HOST_PROC}/meminfo`)
  if (!text) return null

  const values = {}
  for (const line of text.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)/)
    if (match) values[match[1]] = Number(match[2]) * 1024
  }

  if (!values.MemTotal) return null
  const available = values.MemAvailable != null ? values.MemAvailable : (values.MemFree || 0)
  const used = values.MemTotal - available

  return {
    totalBytes: values.MemTotal,
    usedBytes: used,
    percent: Number(((used / values.MemTotal) * 100).toFixed(1))
  }
}

export async function getLoadAverage () {
  const text = await readFileSafe(`${HOST_PROC}/loadavg`)
  if (!text) return null

  const parts = text.trim().split(/\s+/)
  const [load1, load5, load15] = parts.map(Number)
  if ([load1, load5, load15].some(Number.isNaN)) return null

  return { load1, load5, load15 }
}

export async function getUptime () {
  const text = await readFileSafe(`${HOST_PROC}/uptime`)
  if (!text) return null

  const seconds = Math.floor(Number(text.trim().split(/\s+/)[0]))
  if (Number.isNaN(seconds)) return null

  return {
    seconds,
    days: Math.floor(seconds / 86400),
    hours: Math.floor((seconds % 86400) / 3600),
    minutes: Math.floor((seconds % 3600) / 60)
  }
}

async function getHostname () {
  const text = await readFileSafe(`${HOST_ETC}/hostname`)
  if (text) return text.trim()

  try {
    return os.hostname()
  } catch {
    return null
  }
}

async function getOsPrettyName () {
  const text = await readFileSafe(`${HOST_ETC}/os-release`)
  if (!text) return null

  const match = text.match(/^PRETTY_NAME="?([^"\n]+)"?/m)
  return match ? match[1] : null
}

export async function getSystemSnapshot () {
  const [cpuPercent, temperature, memory, loadavg, uptime, hostname, osName] = await Promise.all([
    getCpuUsagePercent().catch(err => { log.error('cpu read failed', err.message); return null }),
    getTemperatureCelsius().catch(err => { log.error('temperature read failed', err.message); return null }),
    getMemoryInfo().catch(err => { log.error('memory read failed', err.message); return null }),
    getLoadAverage().catch(err => { log.error('loadavg read failed', err.message); return null }),
    getUptime().catch(err => { log.error('uptime read failed', err.message); return null }),
    getHostname().catch(() => null),
    getOsPrettyName().catch(() => null)
  ])

  return {
    hostname,
    os: osName,
    kernel: os.release(),
    arch: os.arch(),
    cpuCount: getCpuCoreCount(),
    cpuPercent,
    temperature,
    memory,
    loadavg,
    uptime
  }
}
