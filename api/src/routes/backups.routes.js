import { Router } from 'express'
import { requireAuth } from '../features/auth/sessions.js'
import { asyncHandler } from '../middleware/async-handler.js'
import { runBackup, listBackups, resolveBackupFile, deleteBackup } from '../features/backups/actions.js'
import { runSelfBackup, SELF_PROJECT_NAME } from '../features/backups/self-backup.js'
import { t } from '../lib/i18n.js'

const router = Router()
router.use(requireAuth)

router.get('/:project', asyncHandler(async (req, res) => {
  res.json({ ok: true, backups: await listBackups(req.params.project) })
}))

router.post('/:project', asyncHandler(async (req, res) => {
  const retentionDays = req.body && req.body.retentionDays
  const result = req.params.project === SELF_PROJECT_NAME
    ? await runSelfBackup({ retentionDays })
    : await runBackup(req.params.project, { retentionDays, lang: req.lang })
  res.json({ ok: true, ...result })
}))

router.get('/:project/:filename', (req, res) => {
  let filePath
  try {
    filePath = resolveBackupFile(req.params.project, req.params.filename)
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: t(req.lang, err.message, err.vars) })
    return
  }
  res.download(filePath, req.params.filename, (err) => {
    if (err && !res.headersSent) {
      const statusCode = err.code === 'ENOENT' ? 404 : 500
      res.status(statusCode).json({ ok: false, error: t(req.lang, 'err.backupNotFound') })
    }
  })
})

router.delete('/:project/:filename', asyncHandler(async (req, res) => {
  await deleteBackup(req.params.project, req.params.filename)
  res.json({ ok: true })
}))

export default router
