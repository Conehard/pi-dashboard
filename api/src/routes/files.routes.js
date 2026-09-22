import { Router } from 'express'
import { requireAuth } from '../features/auth/sessions.js'
import { asyncHandler } from '../middleware/async-handler.js'
import {
  listRoots, listDir, prepareDownload, makeDir, uploadFile, renameEntry, moveEntries, deleteEntries
} from '../features/files/files.js'
import { t } from '../lib/i18n.js'

const router = Router()
router.use(requireAuth)

function body (req) {
  return req.body || {}
}

router.get('/roots', asyncHandler(async (req, res) => {
  res.json({ ok: true, roots: await listRoots() })
}))

router.get('/list', asyncHandler(async (req, res) => {
  res.json({ ok: true, ...(await listDir(req.query.root, req.query.path || '')) })
}))

// Plain GET (not fetch) on purpose - the browser opens/downloads it directly (link or new tab), so big
// files stream straight to disk, and video/audio get Range support (seeking) from sendFile.
router.get('/download', asyncHandler(async (req, res) => {
  const { real, headers } = await prepareDownload(req.query.root, req.query.path || '', { inline: req.query.inline === '1' })
  res.set(headers)
  res.sendFile(real, { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) {
      res.status(err.statusCode || 500).json({ ok: false, error: t(req.lang, 'err.filesNotFound') })
    }
  })
}))

// Raw request body = the file's bytes (not multipart) - streamed straight to disk by uploadFile().
router.put('/upload', asyncHandler(async (req, res) => {
  const result = await uploadFile(req.query.root, req.query.path || '', req.query.name, req, {
    overwrite: req.query.overwrite === '1'
  })
  res.json({ ok: true, ...result })
}))

router.post('/mkdir', asyncHandler(async (req, res) => {
  const { root, path, name } = body(req)
  await makeDir(root, path || '', name)
  res.json({ ok: true })
}))

router.post('/rename', asyncHandler(async (req, res) => {
  const { root, path, newName } = body(req)
  await renameEntry(root, path, newName)
  res.json({ ok: true })
}))

router.post('/move', asyncHandler(async (req, res) => {
  const { items, destRoot, destPath } = body(req)
  res.json({ ok: true, ...(await moveEntries(items, destRoot, destPath || '')) })
}))

router.post('/delete', asyncHandler(async (req, res) => {
  res.json({ ok: true, ...(await deleteEntries(body(req).items)) })
}))

export default router
