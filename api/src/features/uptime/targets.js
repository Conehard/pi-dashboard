import { db } from '../../lib/db.js'
import { ActionError } from '../../lib/errors.js'
import { createLogger } from '../../lib/logger.js'
import { logAudit } from '../audit/audit.js'
import { getRecentSummary } from './checks.js'

const log = createLogger('uptime-store')

db.exec(`
  CREATE TABLE IF NOT EXISTS uptime_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    check_type TEXT NOT NULL,       -- 'http' | 'tcp'
    target TEXT NOT NULL,           -- URL (http) or "host:port" (tcp)
    expected_status INTEGER,        -- http only, NULL = accept any 2xx
    interval_seconds INTEGER NOT NULL DEFAULT 60,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
`)

const statements = {
  insertTarget: db.prepare(`
    INSERT INTO uptime_targets (name, check_type, target, expected_status, interval_seconds, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  updateTarget: db.prepare(`
    UPDATE uptime_targets
    SET name = ?, check_type = ?, target = ?, expected_status = ?, interval_seconds = ?, enabled = ?
    WHERE id = ?
  `),
  deleteTarget: db.prepare('DELETE FROM uptime_targets WHERE id = ?'),
  getTarget: db.prepare('SELECT * FROM uptime_targets WHERE id = ?'),
  listTargets: db.prepare('SELECT * FROM uptime_targets ORDER BY created_at ASC'),
  listEnabledTargets: db.prepare('SELECT * FROM uptime_targets WHERE enabled = 1')
}

function normalizeAndValidate ({ name, checkType, target, expectedStatus, intervalSeconds, enabled }) {
  const cleanName = typeof name === 'string' ? name.trim() : ''
  if (!cleanName) throw new ActionError('err.nameRequired', 400)

  if (checkType !== 'http' && checkType !== 'tcp') {
    throw new ActionError('err.uptimeCheckTypeInvalid', 400)
  }

  const cleanTarget = typeof target === 'string' ? target.trim() : ''
  if (!cleanTarget) throw new ActionError('err.uptimeTargetRequired', 400)
  if (checkType === 'http' && !/^https?:\/\//i.test(cleanTarget)) {
    throw new ActionError('err.uptimeTargetHttpFormat', 400)
  }
  if (checkType === 'tcp' && !/^[^\s:]+:\d{1,5}$/.test(cleanTarget)) {
    throw new ActionError('err.uptimeTargetTcpFormat', 400)
  }

  let cleanExpectedStatus = null
  if (expectedStatus !== undefined && expectedStatus !== null && expectedStatus !== '') {
    const n = Number(expectedStatus)
    if (!Number.isInteger(n) || n < 100 || n > 599) {
      throw new ActionError('err.uptimeExpectedStatusInvalid', 400)
    }
    cleanExpectedStatus = n
  }

  const cleanInterval = intervalSeconds !== undefined && intervalSeconds !== null && intervalSeconds !== ''
    ? Number(intervalSeconds)
    : 60
  if (!Number.isInteger(cleanInterval) || cleanInterval < 15 || cleanInterval > 86400) {
    throw new ActionError('err.uptimeIntervalInvalid', 400)
  }

  return {
    name: cleanName,
    checkType,
    target: cleanTarget,
    expectedStatus: cleanExpectedStatus,
    intervalSeconds: cleanInterval,
    enabled: enabled !== false
  }
}

function publicTarget (row) {
  const summary = getRecentSummary(row.id)
  return {
    id: row.id,
    name: row.name,
    checkType: row.check_type,
    target: row.target,
    expectedStatus: row.expected_status,
    intervalSeconds: row.interval_seconds,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    ...summary
  }
}

export function listTargets () {
  return statements.listTargets.all().map(publicTarget)
}

export function getTarget (id) {
  const row = statements.getTarget.get(id)
  return row ? publicTarget(row) : null
}

export function createTarget (input) {
  const clean = normalizeAndValidate(input)
  const now = new Date().toISOString()
  const result = statements.insertTarget.run(
    clean.name, clean.checkType, clean.target, clean.expectedStatus, clean.intervalSeconds, clean.enabled ? 1 : 0, now
  )
  log.info(`target created: "${clean.name}" (${clean.checkType} ${clean.target})`)
  logAudit('uptime.target.create', { target: clean.name, detail: clean.target })
  return getTarget(result.lastInsertRowid)
}

export function updateTarget (id, updates) {
  const existing = statements.getTarget.get(id)
  if (!existing) throw new ActionError('err.uptimeTargetNotFound', 404, { id })

  const merged = {
    name: updates.name !== undefined ? updates.name : existing.name,
    checkType: updates.checkType !== undefined ? updates.checkType : existing.check_type,
    target: updates.target !== undefined ? updates.target : existing.target,
    expectedStatus: updates.expectedStatus !== undefined ? updates.expectedStatus : existing.expected_status,
    intervalSeconds: updates.intervalSeconds !== undefined ? updates.intervalSeconds : existing.interval_seconds,
    enabled: updates.enabled !== undefined ? updates.enabled : !!existing.enabled
  }
  const clean = normalizeAndValidate(merged)

  statements.updateTarget.run(
    clean.name, clean.checkType, clean.target, clean.expectedStatus, clean.intervalSeconds, clean.enabled ? 1 : 0, id
  )
  logAudit('uptime.target.update', { target: clean.name, detail: clean.enabled ? 'ativo' : 'pausado' })
  return getTarget(id)
}

export function deleteTarget (id) {
  const existing = statements.getTarget.get(id)
  if (!existing) throw new ActionError('err.uptimeTargetNotFound', 404, { id })
  statements.deleteTarget.run(id)
  log.info(`target deleted: "${existing.name}" (#${id})`)
  logAudit('uptime.target.delete', { target: existing.name })
}

export function listEnabledTargets () {
  return statements.listEnabledTargets.all().map((row) => ({
    id: row.id,
    name: row.name,
    checkType: row.check_type,
    target: row.target,
    expectedStatus: row.expected_status,
    intervalSeconds: row.interval_seconds
  }))
}
