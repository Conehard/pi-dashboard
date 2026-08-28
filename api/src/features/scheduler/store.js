import { promises as fs } from 'fs'
import path from 'path'
import { Cron } from 'croner'
import { db, DATA_DIR, ensureColumn } from '../../lib/db.js'
import { createLogger } from '../../lib/logger.js'
import { ActionError } from '../../lib/errors.js'
import { getProjectDir } from '../compose/registry.js'
import { logAudit } from '../audit/audit.js'

const log = createLogger('scheduler')
const MAX_RUNS_PER_JOB = 10

const ACTION_TYPES = new Set(['compose-update', 'docker-prune', 'backup', 'self-backup'])

ensureColumn('job_runs', 'skipped', 'skipped INTEGER NOT NULL DEFAULT 0')

const statements = {
  insertJob: db.prepare('INSERT INTO jobs (id, name, schedule, action, enabled) VALUES (?, ?, ?, ?, ?)'),
  updateJob: db.prepare('UPDATE jobs SET name = ?, schedule = ?, action = ?, enabled = ? WHERE id = ?'),
  deleteJob: db.prepare('DELETE FROM jobs WHERE id = ?'),
  getJob: db.prepare('SELECT * FROM jobs WHERE id = ?'),
  listJobs: db.prepare('SELECT * FROM jobs ORDER BY created_at ASC'),
  insertRun: db.prepare(`
    INSERT INTO job_runs (job_id, started_at, finished_at, ok, error, output, skipped)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  listRuns: db.prepare(`
    SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?
  `),
  pruneRuns: db.prepare(`
    DELETE FROM job_runs
    WHERE job_id = ? AND id NOT IN (
      SELECT id FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?
    )
  `),
  countJobs: db.prepare('SELECT COUNT(*) AS n FROM jobs')
}

function newId () {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function validateSchedule (schedule) {
  if (typeof schedule !== 'string' || !schedule.trim()) {
    throw new ActionError('err.scheduleRequired', 400)
  }
  let cron
  try {
    cron = new Cron(schedule)
  } catch (err) {
    throw new ActionError('err.invalidCronExpression', 400, { schedule, detail: err.message })
  } finally {
    if (cron) cron.stop()
  }
}

function validateAction (action) {
  if (!action || !ACTION_TYPES.has(action.type)) {
    throw new ActionError('err.invalidActionType', 400)
  }
  if (action.type === 'compose-update' || action.type === 'backup') {
    if (!action.project || !getProjectDir(action.project)) {
      throw new ActionError('err.projectNotComposeManagedActive', 400, { project: action.project })
    }
  }
  if ((action.type === 'backup' || action.type === 'self-backup') && action.retentionDays !== undefined) {
    if (typeof action.retentionDays !== 'number' || action.retentionDays < 0) {
      throw new ActionError('err.retentionDaysInvalid', 400)
    }
  }
}

function runRow (row) {
  return {
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ok: !!row.ok,
    error: row.error,
    output: row.output,
    skipped: !!row.skipped
  }
}

function publicJob (row) {
  const runs = statements.listRuns.all(row.id, MAX_RUNS_PER_JOB).map(runRow)
  return {
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    enabled: !!row.enabled,
    action: JSON.parse(row.action),
    lastRun: runs[0] || null,
    runs
  }
}

// Pure persistence - no cron scheduling here. runner.js wraps these with
// scheduleJob/unscheduleJob to keep the running cron instances in sync with
// whatever gets created/changed/removed, and is what routes/server import.

export function getJobRow (id) {
  return statements.getJob.get(id)
}

export async function listJobs () {
  return statements.listJobs.all().map(publicJob)
}

export async function insertJob ({ name, schedule, action, enabled }) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new ActionError('err.nameRequired', 400)
  }
  validateSchedule(schedule)
  validateAction(action)

  const row = {
    id: newId(),
    name: name.trim(),
    schedule,
    action,
    enabled: enabled !== false
  }

  statements.insertJob.run(row.id, row.name, row.schedule, JSON.stringify(row.action), row.enabled ? 1 : 0)
  logAudit('scheduler.job.create', { target: row.name, detail: `${row.action.type} · ${row.schedule}` })
  return publicJob(statements.getJob.get(row.id))
}

export async function persistJobUpdate (id, updates) {
  const existing = statements.getJob.get(id)
  if (!existing) throw new ActionError('err.jobNotFound', 404, { id })

  if (updates.schedule !== undefined) validateSchedule(updates.schedule)
  if (updates.action !== undefined) validateAction(updates.action)

  const merged = {
    id,
    name: updates.name !== undefined ? updates.name.trim() : existing.name,
    schedule: updates.schedule !== undefined ? updates.schedule : existing.schedule,
    action: updates.action !== undefined ? updates.action : JSON.parse(existing.action),
    enabled: updates.enabled !== undefined ? !!updates.enabled : !!existing.enabled
  }

  statements.updateJob.run(merged.name, merged.schedule, JSON.stringify(merged.action), merged.enabled ? 1 : 0, id)
  logAudit('scheduler.job.update', { target: merged.name, detail: merged.enabled ? 'ativo' : 'pausado' })
  return publicJob(statements.getJob.get(id))
}

export async function removeJob (id) {
  const existing = statements.getJob.get(id)
  if (!existing) throw new ActionError('err.jobNotFound', 404, { id })
  statements.deleteJob.run(id)
  logAudit('scheduler.job.delete', { target: existing.name })
}

export function recordRun (jobId, result) {
  statements.insertRun.run(jobId, result.startedAt, result.finishedAt, result.ok ? 1 : 0, result.error, result.output, result.skipped ? 1 : 0)
  statements.pruneRuns.run(jobId, jobId, MAX_RUNS_PER_JOB)
}

export async function migrateFromJsonFile () {
  if (statements.countJobs.get().n > 0) return

  const legacyPath = path.join(DATA_DIR, 'scheduler-jobs.json')
  let raw
  try {
    raw = await fs.readFile(legacyPath, 'utf8')
  } catch {
    return
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log.error('legacy scheduler-jobs.json exists but is not valid JSON - skipping migration', err.message)
    return
  }

  const legacyJobs = Array.isArray(parsed.jobs) ? parsed.jobs : []
  if (legacyJobs.length === 0) return

  const migrate = db.transaction((jobsToMigrate) => {
    for (const job of jobsToMigrate) {
      statements.insertJob.run(job.id, job.name, job.schedule, JSON.stringify(job.action), job.enabled ? 1 : 0)
      for (const run of (job.runs || [])) {
        statements.insertRun.run(job.id, run.startedAt, run.finishedAt, run.ok ? 1 : 0, run.error || null, run.output || null, 0)
      }
    }
  })
  migrate(legacyJobs)

  log.info(`migrated ${legacyJobs.length} job(s) from legacy scheduler-jobs.json into SQLite`)

  await fs.rename(legacyPath, `${legacyPath}.migrated`).catch((err) =>
    log.error('migrated jobs into SQLite but failed to rename the old JSON file', err.message)
  )
}
