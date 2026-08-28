import { Router } from 'express'
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  isSessionValid,
  getCookie,
  requireAuth,
  listSessions,
  revokeSession
} from '../features/auth/sessions.js'
import {
  checkCredentials,
  changeCredentials,
  setupCredentials,
  hasAuthConfig
} from '../features/auth/credentials.js'
import { asyncHandler } from '../middleware/async-handler.js'
import { t } from '../lib/i18n.js'

const router = Router()

router.post('/setup', asyncHandler(async (req, res) => {
  const { token, expiresAt } = setupCredentials({
    ...(req.body || {}),
    ip: req.ip,
    userAgent: req.headers['user-agent']
  })
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: expiresAt.getTime() - Date.now()
  })
  res.json({ ok: true })
}))

router.post('/login', (req, res) => {
  const { username, password } = req.body || {}
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ ok: false, error: t(req.lang, 'err.usernamePasswordRequired') })
    return
  }
  if (!checkCredentials(username, password)) {
    res.status(401).json({ ok: false, error: t(req.lang, 'err.invalidCredentials') })
    return
  }
  const { token, expiresAt } = createSession({ ip: req.ip, userAgent: req.headers['user-agent'] })
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: expiresAt.getTime() - Date.now()
  })
  res.json({ ok: true })
})

router.post('/logout', (req, res) => {
  destroySession(getCookie(req, SESSION_COOKIE))
  res.clearCookie(SESSION_COOKIE, { path: '/' })
  res.json({ ok: true })
})

router.get('/status', (req, res) => {
  res.json({
    ok: true,
    authenticated: isSessionValid(getCookie(req, SESSION_COOKIE)),
    needsSetup: !hasAuthConfig()
  })
})

router.use(requireAuth)

router.post('/change-credentials', asyncHandler(async (req, res) => {
  changeCredentials(req.body || {})
  res.clearCookie(SESSION_COOKIE, { path: '/' })
  res.json({ ok: true })
}))

router.get('/sessions', (req, res) => {
  res.json({ ok: true, sessions: listSessions(getCookie(req, SESSION_COOKIE)) })
})

router.delete('/sessions/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, error: t(req.lang, 'err.invalidSessionId') })
    return
  }
  const removed = revokeSession(id)
  res.json({ ok: true, removed })
})

export default router
