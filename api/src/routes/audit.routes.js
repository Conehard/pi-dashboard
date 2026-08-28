import { Router } from 'express'
import { requireAuth } from '../features/auth/sessions.js'
import { listAudit } from '../features/audit/audit.js'

const router = Router()
router.use(requireAuth)

router.get('/', (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined
  res.json({ ok: true, entries: listAudit({ limit }) })
})

export default router
