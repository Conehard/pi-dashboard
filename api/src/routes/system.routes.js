import { Router } from 'express'
import { requireAuth } from '../features/auth/sessions.js'
import { asyncHandler } from '../middleware/async-handler.js'
import { getSystemSnapshot } from '../features/system/system.js'
import { getStorageSnapshot } from '../features/system/storage.js'
import { getDockerSnapshot } from '../features/docker/metrics.js'
import { getMinerSnapshot } from '../features/system/miner.js'
import { getNetworkSnapshot } from '../features/system/network.js'
import { getTopProcesses } from '../features/system/processes.js'
import { getSystemUpdatesSnapshot } from '../features/system/apt-updates.js'
import { getCloudflaredSnapshot } from '../features/system/cloudflared.js'
import { getTailscaleSnapshot } from '../features/system/tailscale.js'
import { getInternetSnapshot, runSpeedtest } from '../features/system/internet.js'
import { recordSampleIfDue, getHistory as getMetricsHistory } from '../features/system/history-store.js'
import { rebootHost } from '../features/system/power.js'

const router = Router()
router.use(requireAuth)

router.get('/system', async (req, res) => {
  const [system, storage, docker, network, updates, cloudflared, tailscale, internet] = await Promise.all([
    getSystemSnapshot(),
    getStorageSnapshot(),
    getDockerSnapshot(),
    getNetworkSnapshot(),
    getSystemUpdatesSnapshot(),
    getCloudflaredSnapshot(),
    getTailscaleSnapshot(),
    getInternetSnapshot()
  ])

  const miner = getMinerSnapshot(docker)

  recordSampleIfDue({
    cpuPercent: system.cpuPercent,
    memPercent: system.memory ? system.memory.percent : null,
    tempC: system.temperature,
    internetConnected: internet.available ? internet.connected : null,
    internetLatencyMs: internet.available ? internet.latencyMs : null
  })

  res.json({ timestamp: new Date().toISOString(), system, storage, docker, miner, network, updates, cloudflared, tailscale, internet })
})

router.get('/metrics/history', (req, res) => {
  const hours = req.query.hours ? Number(req.query.hours) : undefined
  res.json({ ok: true, samples: getMetricsHistory({ hours }) })
})

router.post('/system/reboot', asyncHandler(async (req, res) => {
  res.json(await rebootHost())
}))

router.post('/system/internet/speedtest', asyncHandler(async (req, res) => {
  await runSpeedtest()
  res.json({ ok: true, internet: getInternetSnapshot() })
}))

router.get('/processes/top', (req, res) => {
  res.json({ ok: true, ...getTopProcesses() })
})

export default router
