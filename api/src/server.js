import express from 'express'
import { createLogger } from './lib/logger.js'
import { errorHandler } from './middleware/error-handler.js'
import { resolveLanguage } from './lib/i18n.js'

import authRoutes from './routes/auth.routes.js'
import systemRoutes from './routes/system.routes.js'
import hostRoutes from './routes/host.routes.js'
import dockerRoutes from './routes/docker.routes.js'
import composeRoutes from './routes/compose.routes.js'
import schedulerRoutes from './routes/scheduler.routes.js'
import backupsRoutes from './routes/backups.routes.js'
import auditRoutes from './routes/audit.routes.js'
import notificationsRoutes from './routes/notifications.routes.js'
import uptimeRoutes from './routes/uptime.routes.js'

import { cleanupExpiredSessions } from './features/auth/sessions.js'
import { startScheduler } from './features/scheduler/runner.js'
import { startMinerPoller } from './features/system/miner.js'
import { startProcessPoller } from './features/system/processes.js'
import { startInternetPoller } from './features/system/internet.js'
import { startHealthWatch } from './features/system/health-watch.js'
import { startImageUpdateChecker } from './features/docker/image-updates.js'
import { startUptimeChecker } from './features/uptime/checker.js'
import { startNotificationRetryPoller } from './features/notifications/retry-queue.js'

const log = createLogger('server')
const app = express()
const PORT = process.env.PORT || 3000

app.disable('x-powered-by')
app.set('trust proxy', true)
app.use(express.json({ limit: '256kb' }))

app.use((req, res, next) => {
  req.lang = resolveLanguage(req.headers['accept-language'])
  next()
})

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api/auth', authRoutes)
app.use('/api', systemRoutes)
app.use('/api', hostRoutes)
app.use('/api/docker', dockerRoutes)
app.use('/api/compose', composeRoutes)
app.use('/api/scheduler', schedulerRoutes)
app.use('/api/backups', backupsRoutes)
app.use('/api/audit', auditRoutes)
app.use('/api/notifications', notificationsRoutes)
app.use('/api/uptime', uptimeRoutes)

app.use((req, res) => {
  res.status(404).json({ error: 'not found' })
})

app.use(errorHandler)

app.listen(PORT, () => {
  log.info(`pi-dashboard-api listening on port ${PORT}`)
  startMinerPoller()
  startProcessPoller()
  startInternetPoller()
  startHealthWatch()
  startUptimeChecker()
  startNotificationRetryPoller()
  startImageUpdateChecker()
  startScheduler().catch((err) => log.error('failed to start scheduler', err.message))
  cleanupExpiredSessions()
  setInterval(cleanupExpiredSessions, 24 * 60 * 60 * 1000)
})
