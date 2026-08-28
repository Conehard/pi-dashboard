import { getDockerSnapshot } from '../docker/metrics.js'
import { getStorageSnapshot } from './storage.js'
import { getRegistryStatus } from '../compose/registry.js'
import { notify } from '../notifications/dispatch.js'
import { getRoute } from '../notifications/store.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('health-watch')
const POLL_INTERVAL_MS = Number(process.env.HEALTH_WATCH_INTERVAL_MS) || 30000

const SELF_CONTAINER_NAMES = new Set(['pi-dashboard-api', 'pi-dashboard-web'])

let timer = null
let seeded = false
let lastContainerStates = new Map()
let lastDiskAboveThreshold = new Map()
let lastRestartPending = false

async function checkContainers () {
  const snapshot = await getDockerSnapshot()
  if (!snapshot.available) return

  const currentStates = new Map()
  for (const container of snapshot.containers) {
    if (SELF_CONTAINER_NAMES.has(container.name)) continue
    currentStates.set(container.name, container.state)

    if (seeded) {
      const previous = lastContainerStates.get(container.name)
      if (previous === 'running' && container.state !== 'running') {
        notify('container_down', {
          title: 'Container caiu',
          message: `"${container.name}" saiu do estado "running" (agora: "${container.state}").`
        }).catch(() => {})
      }
    }
  }
  lastContainerStates = currentStates
}

async function checkDisk () {
  const route = getRoute('disk_threshold')
  if (!route || route.threshold === null || route.threshold === undefined) return

  const storage = await getStorageSnapshot()
  for (const target of storage) {
    if (target.percent === null) continue
    const above = target.percent >= route.threshold
    const wasAbove = lastDiskAboveThreshold.get(target.label)
    if (seeded && above && !wasAbove) {
      notify('disk_threshold', {
        title: 'Disco acima do limite',
        message: `"${target.label}" está em ${target.percent}% de uso (limite configurado: ${route.threshold}%).`
      }).catch(() => {})
    }
    lastDiskAboveThreshold.set(target.label, above)
  }
}

async function checkRegistryRestartPending () {
  const status = await getRegistryStatus()
  if (seeded && status.restartNeeded && !lastRestartPending) {
    const added = status.pendingAdd.map((p) => p.name)
    const removed = status.pendingRemove
    const parts = []
    if (added.length > 0) parts.push(`adicionar: ${added.join(', ')}`)
    if (removed.length > 0) parts.push(`remover: ${removed.join(', ')}`)
    notify('restart_pending', {
      title: 'Restart manual pendente',
      message: `Registro de projetos compose mudou (${parts.join(' · ')}) - rode "docker compose up -d --build" no host pra aplicar.`
    }).catch(() => {})
  }
  lastRestartPending = status.restartNeeded
}

async function pollOnce () {
  try {
    await checkContainers()
    await checkDisk()
    await checkRegistryRestartPending()
  } catch (err) {
    log.error('poll failed', err.message)
  } finally {
    seeded = true
  }
}

export function startHealthWatch () {
  if (timer) return
  pollOnce()
  timer = setInterval(pollOnce, POLL_INTERVAL_MS)
  timer.unref()
  log.info(`health watch poller started (every ${POLL_INTERVAL_MS}ms)`)
}
