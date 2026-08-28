import Docker from 'dockerode'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('miner')
const docker = new Docker({ socketPath: '/var/run/docker.sock' })

const MINER_NAME = process.env.MINER_CONTAINER_NAME || 'bitcoin-miner'
const POLL_INTERVAL_MS = Number(process.env.MINER_LOG_POLL_INTERVAL_MS) || 20000

const HASHRATE_REGEX = /Hash rate\s+([0-9.]+\s*[kKmMgGtT]?h\/s)\s+([0-9.]+\s*[kKmMgGtT]?h\/s)\s+\(([0-9.]+\s*[kKmMgGtT]?h\/s)\)/
const ANSI_REGEX = /\x1b\[[0-9;]*m/g

let cache = { hashrate: null, hashrateAvg: null, hashrateSmoothed: null, updatedAt: null }
let timer = null

function stripAnsi (text) {
  return text.replace(ANSI_REGEX, '')
}

function demuxLogBuffer (buffer) {
  const parts = []
  let offset = 0

  while (offset + 8 <= buffer.length) {
    const streamType = buffer.readUInt8(offset)
    const length = buffer.readUInt32BE(offset + 4)
    const start = offset + 8
    const end = start + length
    if (streamType > 2 || end > buffer.length) break
    parts.push(buffer.subarray(start, end))
    offset = end
  }

  return offset > 0 ? Buffer.concat(parts).toString('utf8') : buffer.toString('utf8')
}

async function readRecentLogsText (container, isTty) {
  const data = await container.logs({ stdout: true, stderr: true, tail: 100, timestamps: false })
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return isTty ? buffer.toString('utf8') : demuxLogBuffer(buffer)
}

async function pollOnce () {
  try {
    const list = await docker.listContainers({ all: true, filters: JSON.stringify({ name: [MINER_NAME] }) })
    const match = list.find(c => c.Names.some(n => n.replace(/^\//, '') === MINER_NAME))
    if (!match || match.State !== 'running') return

    const container = docker.getContainer(match.Id)
    const inspect = await container.inspect()
    const text = stripAnsi(await readRecentLogsText(container, inspect.Config && inspect.Config.Tty))

    const lines = text.split('\n').filter(l => l.includes('Hash rate'))
    if (lines.length === 0) return

    const found = lines[lines.length - 1].match(HASHRATE_REGEX)
    if (found) {
      cache = {
        hashrate: found[1].trim(),
        hashrateAvg: found[2].trim(),
        hashrateSmoothed: found[3].trim(),
        updatedAt: new Date().toISOString()
      }
    }
  } catch (err) {
    log.error('failed to poll miner logs', err.message)
  }
}

export function startMinerPoller () {
  if (timer) return
  pollOnce()
  timer = setInterval(pollOnce, POLL_INTERVAL_MS)
  timer.unref()
  log.info(`miner log poller started (every ${POLL_INTERVAL_MS}ms, container "${MINER_NAME}")`)
}

export function getMinerSnapshot (dockerSnapshot) {
  if (!dockerSnapshot || !dockerSnapshot.available) {
    return { present: false, error: dockerSnapshot ? dockerSnapshot.error : 'Docker indisponível' }
  }

  const container = dockerSnapshot.containers.find(c => c.name === MINER_NAME)
  if (!container) {
    return { present: false, error: null }
  }

  return {
    present: true,
    state: container.state,
    status: container.status,
    image: container.image,
    cpuPercent: container.cpuPercent,
    memUsageBytes: container.memUsageBytes,
    memLimitBytes: container.memLimitBytes,
    memPercent: container.memPercent,
    pids: container.pids,
    startedAt: container.startedAt,
    uptimeSeconds: container.uptimeSeconds,
    hashrate: cache.hashrate,
    hashrateAvg: cache.hashrateAvg,
    hashrateSmoothed: cache.hashrateSmoothed,
    hashrateUpdatedAt: cache.updatedAt
  }
}
