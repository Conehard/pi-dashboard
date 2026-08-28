import { Router } from 'express'
import { requireAuth } from '../features/auth/sessions.js'
import { asyncHandler } from '../middleware/async-handler.js'
import { listJobs, createJob, updateJob, deleteJob, executeJob } from '../features/scheduler/runner.js'

const router = Router()
router.use(requireAuth)

router.get('/jobs', asyncHandler(async (req, res) => {
  res.json({ ok: true, jobs: await listJobs() })
}))

router.post('/jobs', asyncHandler(async (req, res) => {
  res.json({ ok: true, job: await createJob(req.body || {}) })
}))

router.put('/jobs/:id', asyncHandler(async (req, res) => {
  res.json({ ok: true, job: await updateJob(req.params.id, req.body || {}) })
}))

router.delete('/jobs/:id', asyncHandler(async (req, res) => {
  await deleteJob(req.params.id)
  res.json({ ok: true })
}))

router.post('/jobs/:id/run', asyncHandler(async (req, res) => {
  res.json({ ok: true, result: await executeJob(req.params.id) })
}))

export default router
