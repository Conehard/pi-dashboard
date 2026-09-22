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
import tuyaRoutes from './routes/tuya.routes.js'
import automationsRoutes from './routes/automations.routes.js'
import filesRoutes from './routes/files.routes.js'

import { cleanupExpiredSessions } from './features/auth/sessions.js'
import { startScheduler } from './features/scheduler/runner.js'
import { startMinerPoller } from './features/system/miner.js'
import { startProcessPoller } from './features/system/processes.js'
import { startInternetPoller } from './features/system/internet.js'
import { startHealthWatch } from './features/system/health-watch.js'
import { startImageUpdateChecker } from './features/docker/image-updates.js'
import { startUptimeChecker } from './features/uptime/checker.js'
import { startNotificationRetryPoller } from './features/notifications/retry-queue.js'
import { startTuyaPoller } from './features/tuya/poller.js'
import { startAutomationsEngine } from './features/automations/engine.js'

const log = createLogger('server')
const app = express()
const PORT = process.env.PORT || 3000

// Node's default behavior for an unhandled promise rejection is to crash the whole process - found
// the hard way via a real bug in features/tuya/messaging.js (fixed, but this is a systemic safety net
// for the next one, not a substitute for fixing bugs): a single failed async call anywhere in the app
// (any feature, not just Tuya) shouldn't take the entire dashboard offline for every screen/user. Logs
// loudly instead - this must never become a quiet way to hide a real bug.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection (process kept running)', reason instanceof Error ? reason.stack : reason)
})

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
app.use('/api/tuya', tuyaRoutes)
app.use('/api/automations', automationsRoutes)
app.use('/api/files', filesRoutes)

app.use((req, res) => {
  res.status(404).json({ error: 'not found' })
})

app.use(errorHandler)

const server = app.listen(PORT, () => {
  log.info(`pi-dashboard-api listening on port ${PORT}`)
  startMinerPoller()
  startProcessPoller()
  startInternetPoller()
  startHealthWatch()
  startUptimeChecker()
  startNotificationRetryPoller()
  startImageUpdateChecker()
  startTuyaPoller()
  startAutomationsEngine()
  startScheduler().catch((err) => log.error('failed to start scheduler', err.message))
  cleanupExpiredSessions()
  setInterval(cleanupExpiredSessions, 24 * 60 * 60 * 1000)
})

// Node's default requestTimeout (5min for the WHOLE request, body included) would cut off any file
// manager upload (routes/files.routes.js) that takes longer than that - a multi-GB file over Wi-Fi
// easily does. Disabled rather than just raised: this API is only reachable through the nginx
// container (never published to the host), which already enforces its own per-read timeouts.
server.requestTimeout = 0
