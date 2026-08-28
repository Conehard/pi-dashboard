import { Router } from 'express'
import { requireAuth } from '../features/auth/sessions.js'
import { asyncHandler } from '../middleware/async-handler.js'
import { listTargets, createTarget, updateTarget, deleteTarget } from '../features/uptime/targets.js'
import { getHistory } from '../features/uptime/checks.js'

const router = Router()
router.use(requireAuth)

function parseTargetId (raw) {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('ID de alvo inválido.')
    err.statusCode = 400
    throw err
  }
  return id
}

router.get('/targets', (req, res) => {
  res.json({ ok: true, targets: listTargets() })
})

router.post('/targets', asyncHandler(async (req, res) => {
  res.json({ ok: true, target: createTarget(req.body || {}) })
}))

router.put('/targets/:id', asyncHandler(async (req, res) => {
  res.json({ ok: true, target: updateTarget(parseTargetId(req.params.id), req.body || {}) })
}))

router.delete('/targets/:id', asyncHandler(async (req, res) => {
  deleteTarget(parseTargetId(req.params.id))
  res.json({ ok: true })
}))

router.get('/targets/:id/history', asyncHandler(async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined
  res.json({ ok: true, history: getHistory(parseTargetId(req.params.id), { limit }) })
}))

export default router
