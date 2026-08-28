import { Router } from 'express'
import { requireAuth } from '../features/auth/sessions.js'
import { asyncHandler } from '../middleware/async-handler.js'
import { t } from '../lib/i18n.js'
import { listComposeProjects, readComposeFile, writeComposeFile, runComposeAction } from '../features/compose/run.js'
import { getRegistryStatus, registerProject, unregisterProject } from '../features/compose/registry.js'

const router = Router()
router.use(requireAuth)

router.get('/projects', asyncHandler(async (req, res) => {
  const projects = await listComposeProjects()
  res.json({ ok: true, projects: projects.map(p => p.name) })
}))

router.get('/projects/:project/file', asyncHandler(async (req, res) => {
  const content = await readComposeFile(req.params.project)
  res.json({ ok: true, content })
}))

router.put('/projects/:project/file', asyncHandler(async (req, res) => {
  const { content } = req.body || {}
  if (typeof content !== 'string' || content.trim().length === 0) {
    res.status(400).json({ ok: false, error: t(req.lang, 'err.composeContentRequired') })
    return
  }
  await writeComposeFile(req.params.project, content)
  res.json({ ok: true })
}))

router.get('/projects/:project/run/:action', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders()

  const send = (line) => res.write(`data: ${JSON.stringify(line)}\n\n`)
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000)

  let exitCode
  try {
    exitCode = await runComposeAction(req.params.project, req.params.action, send)
  } catch (err) {
    clearInterval(keepAlive)
    res.write(`event: error\ndata: ${JSON.stringify(t(req.lang, err.message, err.vars))}\n\n`)
    res.end()
    return
  }

  clearInterval(keepAlive)
  res.write(`event: done\ndata: ${JSON.stringify({ exitCode })}\n\n`)
  res.end()
})

router.get('/registry', asyncHandler(async (req, res) => {
  res.json({ ok: true, ...(await getRegistryStatus()) })
}))

router.post('/registry', asyncHandler(async (req, res) => {
  const { name, path: hostPath } = req.body || {}
  if (typeof name !== 'string' || typeof hostPath !== 'string') {
    res.status(400).json({ ok: false, error: t(req.lang, 'err.nameAndPathRequired') })
    return
  }
  await registerProject(name, hostPath)
  res.json({ ok: true, restartNeeded: true })
}))

router.post('/registry/:name/unregister', asyncHandler(async (req, res) => {
  await unregisterProject(req.params.name)
  res.json({ ok: true, restartNeeded: true })
}))

export default router
