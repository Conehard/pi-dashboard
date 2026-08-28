import { createLogger } from '../../lib/logger.js'

const log = createLogger('telegram')
const API_BASE = 'https://api.telegram.org'
const TIMEOUT_MS = 8000

async function callTelegram (token, method, body) {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const data = await res.json().catch(() => null)
  return { ok: res.ok && !!data && data.ok === true, status: res.status, data }
}

export async function validateBotToken (token) {
  let result
  try {
    result = await callTelegram(token, 'getMe', {})
  } catch (err) {
    const error = new Error(`Não foi possível contatar a API do Telegram: ${err.message}`)
    error.statusCode = 502
    throw error
  }
  if (!result.ok) {
    const desc = (result.data && result.data.description) || `HTTP ${result.status}`
    const error = new Error(`Token do bot inválido: ${desc}`)
    error.statusCode = 400
    throw error
  }
  return result.data.result.username
}

export async function sendTelegramMessage (token, chatId, text) {
  try {
    const result = await callTelegram(token, 'sendMessage', { chat_id: chatId, text })
    if (!result.ok) {
      const desc = (result.data && result.data.description) || `HTTP ${result.status}`
      log.error(`falha ao enviar mensagem pro chat ${chatId}: ${desc}`)
      return { ok: false, error: desc }
    }
    return { ok: true }
  } catch (err) {
    log.error(`falha ao enviar mensagem pro chat ${chatId}`, err.message)
    return { ok: false, error: err.message }
  }
}
