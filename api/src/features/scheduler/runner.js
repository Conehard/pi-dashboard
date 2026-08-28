import { Cron } from 'croner'
import { createLogger } from '../../lib/logger.js'
import { ActionError } from '../../lib/errors.js'
import { pruneImages } from '../docker/project.js'
import { runComposeAction } from '../compose/run.js'
import { runBackup } from '../backups/actions.js'
import { runSelfBackup } from '../backups/self-backup.js'
import { notify } from '../notifications/dispatch.js'
import * as store from './store.js'

const log = createLogger('scheduler')
const MAX_OUTPUT_CHARS = 4000
const JOB_RETRY_ATTEMPTS = 3
const JOB_RETRY_BACKOFF_MS = [30 * 1000, 2 * 60 * 1000]

const cronInstances = new Map()

function unscheduleJob (id) {
  const cron = cronInstances.get(id)
  if (cron) {
    cron.stop()
    cronInstances.delete(id)
  }
}

function scheduleJob (job) {
  unscheduleJob(job.id)
  if (!job.enabled) return
  try {
    const cron = new Cron(job.schedule, () => {
      executeJob(job.id, { maxAttempts: JOB_RETRY_ATTEMPTS }).catch((err) => log.error(`unhandled error running job ${job.id}`, err.message))
    })
    cronInstances.set(job.id, cron)
  } catch (err) {
    log.error(`failed to schedule job ${job.id} ("${job.schedule}")`, err.message)
  }
}

export async function listJobs () {
  return store.listJobs()
}

export async function createJob (input) {
  const job = await store.insertJob(input)
  scheduleJob(job)
  return job
}

export async function updateJob (id, updates) {
  const job = await store.persistJobUpdate(id, updates)
  scheduleJob(job)
  return job
}

export async function deleteJob (id) {
  await store.removeJob(id)
  unscheduleJob(id)
}

async function runJobAction (job) {
  const lines = []
  const onLine = (line) => lines.push(line)
  let ok = true
  let skipped = false
  let errorMessage = null

  try {
    if (job.action.type === 'compose-update') {
      const pullCode = await runComposeAction(job.action.project, 'pull', onLine)
      const upCode = await runComposeAction(job.action.project, 'up', onLine)
      ok = pullCode === 0 && upCode === 0
      if (!ok) errorMessage = `pull/up saíram com código ${pullCode}/${upCode}`
    } else if (job.action.type === 'docker-prune') {
      const result = await pruneImages()
      onLine(`${result.imagesDeleted} imagem(ns) removida(s), ${result.spaceReclaimedBytes} bytes liberados`)
    } else if (job.action.type === 'backup') {
      const result = await runBackup(job.action.project, { retentionDays: job.action.retentionDays })
      if (result.skipped) {
        skipped = true
        onLine(result.reason)
      } else {
        onLine(`backup "${result.file}" criado (${result.sizeBytes} bytes)`)
        if (result.removed.length > 0) onLine(`removidos por retenção: ${result.removed.join(', ')}`)
      }
    } else if (job.action.type === 'self-backup') {
      const result = await runSelfBackup({ retentionDays: job.action.retentionDays })
      onLine(`backup "${result.file}" criado (${result.sizeBytes} bytes)`)
      if (result.removed.length > 0) onLine(`removidos por retenção: ${result.removed.join(', ')}`)
    }
  } catch (err) {
    ok = false
    errorMessage = err.message
    onLine(`[erro] ${err.message}`)
  }

  return { ok, skipped, error: errorMessage, lines }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function executeJob (id, { maxAttempts = 1 } = {}) {
  const row = store.getJobRow(id)
  if (!row) throw new ActionError('err.jobNotFound', 404, { id })
  const job = { id: row.id, name: row.name, action: JSON.parse(row.action) }

  const startedAt = new Date().toISOString()
  const allLines = []
  let attemptResult

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptResult = await runJobAction(job)
    if (attempt > 1) allLines.push(`--- tentativa ${attempt} ---`)
    allLines.push(...attemptResult.lines)

    if (attemptResult.ok || attemptResult.skipped) break
    if (attempt < maxAttempts) {
      const delayMs = JOB_RETRY_BACKOFF_MS[attempt - 1] || JOB_RETRY_BACKOFF_MS[JOB_RETRY_BACKOFF_MS.length - 1]
      allLines.push(`tentativa ${attempt} falhou (${attemptResult.error || 'ver acima'}), tentando de novo em ${Math.round(delayMs / 1000)}s`)
      await sleep(delayMs)
    }
  }

  const { ok, skipped, error: errorMessage } = attemptResult

  const result = {
    startedAt,
    finishedAt: new Date().toISOString(),
    ok,
    skipped,
    error: errorMessage,
    output: allLines.join('\n').slice(-MAX_OUTPUT_CHARS)
  }

  store.recordRun(id, result)
  if (!ok) {
    log.error(`job "${job.name}" (${id}) failed`, errorMessage || 'see output')
    notify('job_failure', {
      title: 'Falha de job agendado',
      message: `"${job.name}" falhou${maxAttempts > 1 ? ` após ${maxAttempts} tentativas` : ''}: ${errorMessage || 'ver histórico no painel de Tarefas'}`
    }).catch(() => {})
  } else if (skipped) {
    log.info(`job "${job.name}" (${id}) skipped`, errorMessage || allLines.join(' | '))
    notify('job_failure', {
      title: 'Backup agendado pulado',
      message: `"${job.name}" não gerou backup: ${allLines[allLines.length - 1] || 'ver histórico no painel de Tarefas'}`
    }).catch(() => {})
  }
  return result
}

export async function startScheduler () {
  await store.migrateFromJsonFile()

  const jobs = await store.listJobs()
  jobs.forEach(scheduleJob)
  log.info(`scheduler started with ${jobs.length} job(s), ${cronInstances.size} scheduled`)
}
