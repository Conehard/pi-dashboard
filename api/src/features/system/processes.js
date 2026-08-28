import { promises as fs } from 'fs'
import path from 'path'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('processes')
const HOST_PROC = '/host/proc'
const POLL_INTERVAL_MS = Number(process.env.PROCESS_POLL_INTERVAL_MS) || 5000
const TOP_N = 8
const CLK_TCK = 100

let previousSamples = new Map()
let cache = { available: false, topCpu: [], topMem: [], updatedAt: null }
let timer = null

async function readPidTicks (pid) {
  const raw = await fs.readFile(path.join(HOST_PROC, pid, 'stat'), 'utf8')
  const rest = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
  const utime = Number(rest[11])
  const stime = Number(rest[12])
  if (Number.isNaN(utime) || Number.isNaN(stime)) return null
  return utime + stime
}

async function readPidInfo (pid) {
  const raw = await fs.readFile(path.join(HOST_PROC, pid, 'status'), 'utf8')
  const nameMatch = raw.match(/^Name:\s*(.+)$/m)
  const rssMatch = raw.match(/^VmRSS:\s*(\d+)\s*kB$/m)
  return {
    name: nameMatch ? nameMatch[1].trim() : `pid ${pid}`,
    rssBytes: rssMatch ? Number(rssMatch[1]) * 1024 : 0
  }
}

async function pollOnce () {
  let pids
  try {
    const entries = await fs.readdir(HOST_PROC, { withFileTypes: true })
    pids = entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => e.name)
  } catch (err) {
    log.error('failed to list /host/proc', err.message)
    cache = { available: false, topCpu: [], topMem: [], updatedAt: null }
    return
  }

  const now = Date.now()
  const nextSamples = new Map()
  const results = []

  await Promise.all(pids.map(async (pid) => {
    try {
      const [ticks, info] = await Promise.all([readPidTicks(pid), readPidInfo(pid)])
      if (ticks === null) return
      nextSamples.set(pid, { ticks, timestamp: now })

      let cpuPercent = null
      const prev = previousSamples.get(pid)
      if (prev) {
        const elapsedSeconds = (now - prev.timestamp) / 1000
        const ticksDelta = ticks - prev.ticks
        if (elapsedSeconds > 0 && ticksDelta >= 0) {
          cpuPercent = Number(((ticksDelta / CLK_TCK / elapsedSeconds) * 100).toFixed(1))
        }
      }

      results.push({ pid: Number(pid), name: info.name, cpuPercent, rssBytes: info.rssBytes })
    } catch {
    }
  }))

  previousSamples = nextSamples

  const topCpu = results
    .filter((p) => p.cpuPercent !== null)
    .sort((a, b) => b.cpuPercent - a.cpuPercent)
    .slice(0, TOP_N)

  const topMem = [...results]
    .sort((a, b) => b.rssBytes - a.rssBytes)
    .slice(0, TOP_N)

  cache = { available: true, topCpu, topMem, updatedAt: new Date().toISOString() }
}

export function startProcessPoller () {
  if (timer) return
  pollOnce()
  timer = setInterval(pollOnce, POLL_INTERVAL_MS)
  timer.unref()
  log.info(`process poller started (every ${POLL_INTERVAL_MS}ms)`)
}

export function getTopProcesses () {
  return cache
}
