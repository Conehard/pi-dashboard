import { Router } from 'express'
import { requireAuth } from '../features/auth/sessions.js'
import { asyncHandler } from '../middleware/async-handler.js'
import * as store from '../features/automations/store.js'
import { runRuleNow } from '../features/automations/engine.js'

const router = Router()
router.use(requireAuth)

router.get('/rules', (req, res) => {
  res.json({ ok: true, rules: store.listRules() })
})

router.post('/rules', asyncHandler(async (req, res) => {
  res.json({ ok: true, rule: store.createRule(req.body || {}) })
}))

router.put('/rules/:id', asyncHandler(async (req, res) => {
  res.json({ ok: true, rule: store.updateRule(req.params.id, req.body || {}) })
}))

router.delete('/rules/:id', asyncHandler(async (req, res) => {
  store.deleteRule(req.params.id)
  res.json({ ok: true })
}))

// "Run now" - test-fires a rule's actions immediately, outside its trigger, same idea as Tasks jobs'
// own "Run now" button.
router.post('/rules/:id/run', asyncHandler(async (req, res) => {
  const rule = await runRuleNow(req.params.id)
  res.json({ ok: true, rule })
}))

router.get('/rules/:id/runs', asyncHandler(async (req, res) => {
  res.json({ ok: true, runs: store.listRuns(req.params.id) })
}))

export default router
