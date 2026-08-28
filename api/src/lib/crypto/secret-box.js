import crypto from 'crypto'
import { createLogger } from '../logger.js'

const log = createLogger('secret-box')
const ALGORITHM = 'aes-256-gcm'
const KEY_SALT = 'pi-dashboard-notifications'
const IV_LENGTH = 12

let cachedKey = null
let warned = false

function getKey () {
  if (cachedKey) return cachedKey
  const secret = process.env.APP_ENCRYPTION_KEY
  if (!secret) {
    if (!warned) {
      log.error('APP_ENCRYPTION_KEY não está definida - segredos (ex: token do bot do Telegram) não podem ser salvos até isso ser configurado no .env e o container reiniciado.')
      warned = true
    }
    return null
  }
  cachedKey = crypto.scryptSync(secret, KEY_SALT, 32)
  return cachedKey
}

export function encryptionKeyConfigured () {
  return getKey() !== null
}

export function encryptSecret (plaintext) {
  const key = getKey()
  if (!key) {
    const err = new Error('APP_ENCRYPTION_KEY não configurada no servidor - defina no .env e reinicie o container antes de configurar segredos.')
    err.statusCode = 503
    throw err
  }
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':')
}

export function decryptSecret (blob) {
  const key = getKey()
  if (!key) return null
  const [ivHex, tagHex, dataHex] = String(blob || '').split(':')
  if (!ivHex || !tagHex || !dataHex) return null
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
    return plaintext.toString('utf8')
  } catch (err) {
    log.error('falha ao descriptografar um segredo - APP_ENCRYPTION_KEY pode ter mudado desde que foi salvo', err.message)
    return null
  }
}
