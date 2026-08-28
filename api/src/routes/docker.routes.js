import { Router } from 'express'
import { requireAuth } from '../features/auth/sessions.js'
import { asyncHandler } from '../middleware/async-handler.js'
import {
  startContainer,
  stopContainer,
  restartContainer,
  recreateContainer,
  pauseContainer,
  unpauseContainer,
  removeContainer
} from '../features/docker/lifecycle.js'
import { getContainerDetails, streamContainerLogs, demuxToLines } from '../features/docker/inspect.js'
import { actOnProject, pruneImages } from '../features/docker/project.js'
import { getDockerSnapshot } from '../features/docker/metrics.js'
import { getImageUpdatesSnapshot } from '../features/docker/image-updates.js'
import { t } from '../lib/i18n.js'

const router = Router()
router.use(requireAuth)

router.get('/containers', async (req, res) => {
  const snapshot = await getDockerSnapshot()
  res.json({ ...snapshot, imageUpdates: getImageUpdatesSnapshot() })
})

router.post('/containers/:id/start', asyncHandler(async (req, res) => res.json({ ok: true, ...(await startContainer(req.params.id)) })))
router.post('/containers/:id/stop', asyncHandler(async (req, res) => res.json({ ok: true, ...(await stopContainer(req.params.id)) })))
router.post('/containers/:id/restart', asyncHandler(async (req, res) => res.json({ ok: true, ...(await restartContainer(req.params.id)) })))
router.post('/containers/:id/recreate', asyncHandler(async (req, res) => res.json({ ok: true, ...(await recreateContainer(req.params.id)) })))
router.post('/containers/:id/pause', asyncHandler(async (req, res) => res.json({ ok: true, ...(await pauseContainer(req.params.id)) })))
router.post('/containers/:id/unpause', asyncHandler(async (req, res) => res.json({ ok: true, ...(await unpauseContainer(req.params.id)) })))
router.post('/containers/:id/remove', asyncHandler(async (req, res) => res.json({ ok: true, ...(await removeContainer(req.params.id)) })))

router.get('/containers/:id/details', asyncHandler(async (req, res) => {
  res.json({ ok: true, details: await getContainerDetails(req.params.id) })
}))

router.post('/projects/:project/:action', asyncHandler(async (req, res) => {
  res.json({ ok: true, ...(await actOnProject(req.params.project, req.params.action)) })
}))

router.get('/containers/:id/logs', async (req, res) => {
  const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 200, 1), 2000)

  let logStream
  try {
    logStream = await streamContainerLogs(req.params.id, { tail })
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: t(req.lang, err.message, err.vars) })
    return
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders()

  demuxToLines(logStream, (line) => {
    res.write(`data: ${JSON.stringify(line)}\n\n`)
  })

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000)

  const cleanup = () => {
    clearInterval(keepAlive)
    logStream.destroy()
  }

  logStream.on('end', () => { cleanup(); res.end() })
  logStream.on('error', () => { cleanup(); res.end() })
  req.on('close', cleanup)
})

router.post('/prune', asyncHandler(async (req, res) => {
  res.json({ ok: true, ...(await pruneImages()) })
}))

export default router
