import { Router } from 'express'
import { requireAuth } from '../features/auth/sessions.js'
import { getHostScheduleSnapshot } from '../features/system/host-schedule.js'
import { getSmartHealthSnapshot } from '../features/system/smart.js'

const router = Router()
router.use(requireAuth)

router.get('/host-schedule', async (req, res) => {
  res.json({ ok: true, ...(await getHostScheduleSnapshot()) })
})

router.get('/smart-health', async (req, res) => {
  res.json({ ok: true, ...(await getSmartHealthSnapshot()) })
})

export default router
