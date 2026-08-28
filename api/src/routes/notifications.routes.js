import { Router } from 'express'
import { requireAuth } from '../features/auth/sessions.js'
import { verifyCurrentPassword } from '../features/auth/credentials.js'
import { asyncHandler } from '../middleware/async-handler.js'
import {
  EVENT_TYPES,
  isBotConfigured,
  getBotConfig,
  saveBotToken,
  clearBotConfig,
  listRoutes,
  saveRoute,
  isKnownEventType,
  getDecryptedBotToken,
  getDecryptedChatId
} from '../features/notifications/store.js'
import { validateBotToken, sendTelegramMessage } from '../features/notifications/telegram.js'
import { t } from '../lib/i18n.js'

const router = Router()
router.use(requireAuth)

router.get('/status', (req, res) => {
  const bot = getBotConfig()
  res.json({
    ok: true,
    botConfigured: !!bot,
    botUsername: bot ? bot.bot_username : null,
    eventTypes: EVENT_TYPES.map((e) => ({ ...e, label: t(req.lang, `eventType.${e.key}`) })),
    routes: listRoutes()
  })
})

router.post('/bot', asyncHandler(async (req, res) => {
  const { token, currentPassword } = req.body || {}
  if (!verifyCurrentPassword(currentPassword)) {
    res.status(401).json({ ok: false, error: t(req.lang, 'err.currentPasswordIncorrect') })
    return
  }
  if (typeof token !== 'string' || !token.trim()) {
    res.status(400).json({ ok: false, error: t(req.lang, 'err.botTokenRequired') })
    return
  }
  const botUsername = await validateBotToken(token.trim())
  saveBotToken(token.trim(), botUsername)
  res.json({ ok: true, botUsername })
}))

router.delete('/bot', (req, res) => {
  const { currentPassword } = req.body || {}
  if (!verifyCurrentPassword(currentPassword)) {
    res.status(401).json({ ok: false, error: t(req.lang, 'err.currentPasswordIncorrect') })
    return
  }
  clearBotConfig()
  res.json({ ok: true })
})

router.put('/routes/:eventType', asyncHandler(async (req, res) => {
  if (!isKnownEventType(req.params.eventType)) {
    res.status(404).json({ ok: false, error: t(req.lang, 'err.unknownEventType') })
    return
  }
  res.json({ ok: true, route: saveRoute(req.params.eventType, req.body || {}) })
}))

router.post('/test/:eventType', async (req, res) => {
  if (!isKnownEventType(req.params.eventType)) {
    res.status(404).json({ ok: false, error: t(req.lang, 'err.unknownEventType') })
    return
  }
  if (!isBotConfigured()) {
    res.status(400).json({ ok: false, error: t(req.lang, 'err.botNotConfigured') })
    return
  }
  const chatId = getDecryptedChatId(req.params.eventType)
  if (!chatId) {
    res.status(400).json({ ok: false, error: t(req.lang, 'err.noChatConfiguredForRoute') })
    return
  }
  const token = getDecryptedBotToken()
  const result = await sendTelegramMessage(
    token, chatId,
    `Teste de notificação do pi-dashboard - a rota "${req.params.eventType}" está funcionando.`
  )
  res.json({ ok: result.ok, error: result.error || null })
})

export default router
