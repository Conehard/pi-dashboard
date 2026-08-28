import { createLogger } from '../lib/logger.js'
import { t } from '../lib/i18n.js'

const log = createLogger('error-handler')

export function errorHandler (err, req, res, next) {
  const statusCode = err.statusCode || 500
  if (statusCode >= 500) log.error(`unhandled error on ${req.method} ${req.originalUrl}`, err.message)
  const message = err.message ? t(req.lang, err.message, err.vars) : 'internal error'
  res.status(statusCode).json({ ok: false, error: message })
}
