import { docker } from '../../lib/docker-client.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('docker')

function computeCpuPercent (stats) {
  try {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage
    const cpuCount = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage || []).length || 1

    if (systemDelta <= 0 || cpuDelta < 0) return 0
    return Number(((cpuDelta / systemDelta) * cpuCount * 100).toFixed(2))
  } catch {
    return null
  }
}

function computeMemory (stats) {
  try {
    const usage = stats.memory_stats.usage || 0
    const cacheBytes = (stats.memory_stats.stats && stats.memory_stats.stats.file) || 0
    const used = usage - cacheBytes
    const limit = stats.memory_stats.limit || 0
    return {
      usedBytes: used,
      limitBytes: limit,
      percent: limit > 0 ? Number(((used / limit) * 100).toFixed(2)) : null
    }
  } catch {
    return { usedBytes: null, limitBytes: null, percent: null }
  }
}

function baseInfo (info) {
  const labels = info.Labels || {}
  return {
    id: info.Id.slice(0, 12),
    name: info.Names[0].replace(/^\//, ''),
    image: info.Image,
    state: info.State,
    status: info.Status,
    composeProject: labels['com.docker.compose.project'] || null,
    composeService: labels['com.docker.compose.service'] || null,
    cpuPercent: null,
    memUsageBytes: null,
    memLimitBytes: null,
    memPercent: null,
    pids: null,
    startedAt: null,
    uptimeSeconds: null
  }
}

async function statsForContainer (info) {
  const container = docker.getContainer(info.Id)
  const [stats, inspect] = await Promise.all([
    container.stats({ stream: false }),
    container.inspect()
  ])

  const mem = computeMemory(stats)
  const startedAt = inspect.State && inspect.State.StartedAt
  const running = inspect.State && inspect.State.Running
  const uptimeSeconds = running && startedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
    : null

  return {
    ...baseInfo(info),
    cpuPercent: computeCpuPercent(stats),
    memUsageBytes: mem.usedBytes,
    memLimitBytes: mem.limitBytes,
    memPercent: mem.percent,
    pids: stats.pids_stats ? stats.pids_stats.current : null,
    startedAt: startedAt || null,
    uptimeSeconds
  }
}

export async function getDockerSnapshot () {
  try {
    const list = await docker.listContainers({ all: true })

    const containers = await Promise.all(
      list.map(info =>
        statsForContainer(info).catch(err => {
          log.error(`stats unavailable for ${info.Names[0]}`, err.message)
          return baseInfo(info)
        })
      )
    )

    return { available: true, error: null, containers }
  } catch (err) {
    log.error('docker unavailable', err.message)
    return { available: false, error: 'Docker indisponível', containers: [] }
  }
}
