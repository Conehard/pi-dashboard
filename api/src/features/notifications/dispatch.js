import { createLogger } from '../../lib/logger.js'
import { isBotConfigured, getDecryptedBotToken, getRoute, getDecryptedChatId } from './store.js'
import { sendTelegramMessage } from './telegram.js'
import { enqueueRetry } from './retry-queue.js'

const log = createLogger('notifications-dispatch')

export async function attemptSend (eventType, { title, message }) {
  if (!isBotConfigured()) return { ok: false, error: 'bot não configurado', skip: true }
  const route = getRoute(eventType)
  if (!route || !route.enabled || !route.configured) return { ok: false, error: 'rota não configurada', skip: true }

  const token = getDecryptedBotToken()
  const chatId = getDecryptedChatId(eventType)
  if (!token || !chatId) return { ok: false, error: 'token/chat ausente', skip: true }

  const text = title ? `${title}\n${message}` : message
  return sendTelegramMessage(token, chatId, text)
}

export async function notify (eventType, { title, message }) {
  try {
    const result = await attemptSend(eventType, { title, message })
    if (result.skip) return
    if (!result.ok) {
      log.error(`falha ao enviar notificação "${eventType}", agendando retry`, result.error)
      enqueueRetry(eventType, { title, message })
    }
  } catch (err) {
    log.error(`falha ao processar notificação "${eventType}"`, err.message)
  }
}
