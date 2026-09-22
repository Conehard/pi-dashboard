// Persistence for user-defined automation rules (docs/plans/tuya-panel.md Phase 14) - "when device X's
// DPS code Y becomes value Z, do these actions". v1 is deliberately narrow: became-equal-to-X triggers
// only (see the plan's "Open questions" for why), and the trigger side is always a Tuya device today,
// but the row shape doesn't assume that forever - see the "genericity note" in the plan for why
// `actions` is a tagged-union JSON array rather than fixed columns (same idea as `jobs.action` already
// uses for the Tasks scheduler).
import { db } from '../../lib/db.js'
import { ActionError } from '../../lib/errors.js'
import { createLogger } from '../../lib/logger.js'
import { logAudit } from '../audit/audit.js'

const log = createLogger('automations-store')
const MAX_RUNS_PER_RULE = 10
const ACTION_TYPES = new Set(['tuya_command', 'telegram'])

db.exec(`
  CREATE TABLE IF NOT EXISTS automation_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger_device_id TEXT NOT NULL,
    trigger_code TEXT NOT NULL,
    trigger_value TEXT NOT NULL, -- String(value) the DPS must become to fire - see engine.js
    actions TEXT NOT NULL,       -- JSON array of { type: 'tuya_command'|'telegram', ...params }
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS automation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    ran_at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    detail TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_runs_rule ON automation_runs(rule_id, ran_at DESC);
`)

const statements = {
  insertRule: db.prepare(`
    INSERT INTO automation_rules (id, name, enabled, trigger_device_id, trigger_code, trigger_value, actions, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateRule: db.prepare(`
    UPDATE automation_rules
    SET name = ?, enabled = ?, trigger_device_id = ?, trigger_code = ?, trigger_value = ?, actions = ?, updated_at = ?
    WHERE id = ?
  `),
  deleteRule: db.prepare('DELETE FROM automation_rules WHERE id = ?'),
  getRule: db.prepare('SELECT * FROM automation_rules WHERE id = ?'),
  listRules: db.prepare('SELECT * FROM automation_rules ORDER BY created_at ASC'),
  listEnabledRules: db.prepare('SELECT * FROM automation_rules WHERE enabled = 1'),
  insertRun: db.prepare('INSERT INTO automation_runs (rule_id, ran_at, ok, detail) VALUES (?, ?, ?, ?)'),
  listRuns: db.prepare('SELECT * FROM automation_runs WHERE rule_id = ? ORDER BY ran_at DESC LIMIT ?'),
  pruneRuns: db.prepare(`
    DELETE FROM automation_runs
    WHERE rule_id = ? AND id NOT IN (
      SELECT id FROM automation_runs WHERE rule_id = ? ORDER BY ran_at DESC LIMIT ?
    )
  `),
  lastRun: db.prepare('SELECT * FROM automation_runs WHERE rule_id = ? ORDER BY ran_at DESC LIMIT 1')
}

function newId () {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function validateActions (actions) {
  if (!Array.isArray(actions) || !actions.length) {
    throw new ActionError('err.automationActionsRequired', 400)
  }
  for (const action of actions) {
    if (!action || !ACTION_TYPES.has(action.type)) {
      throw new ActionError('err.automationInvalidActionType', 400, { type: action && action.type })
    }
    if (action.type === 'tuya_command' && (!action.deviceId || !action.code)) {
      throw new ActionError('err.automationTuyaActionIncomplete', 400)
    }
    if (action.type === 'telegram' && (!action.chatId || !action.message)) {
      throw new ActionError('err.automationTelegramActionIncomplete', 400)
    }
  }
}

function publicRule (row) {
  const lastRunRow = statements.lastRun.get(row.id)
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    triggerDeviceId: row.trigger_device_id,
    triggerCode: row.trigger_code,
    triggerValue: row.trigger_value,
    actions: JSON.parse(row.actions),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRun: lastRunRow ? { ranAt: lastRunRow.ran_at, ok: !!lastRunRow.ok, detail: lastRunRow.detail } : null
  }
}

export function listRules () {
  return statements.listRules.all().map(publicRule)
}

// Internal - used by engine.js's tick, not the routes (avoids re-parsing JSON/looking up last-run for
// every rule on every tick, publicRule() does more work than the engine needs).
export function listEnabledRulesRaw () {
  return statements.listEnabledRules.all().map((row) => ({
    id: row.id,
    name: row.name,
    triggerDeviceId: row.trigger_device_id,
    triggerCode: row.trigger_code,
    triggerValue: row.trigger_value,
    actions: JSON.parse(row.actions)
  }))
}

export function getRule (id) {
  const row = statements.getRule.get(id)
  return row ? publicRule(row) : null
}

function requireRule (id) {
  const row = statements.getRule.get(id)
  if (!row) throw new ActionError('err.automationRuleNotFound', 404, { id })
  return row
}

export function createRule ({ name, enabled, triggerDeviceId, triggerCode, triggerValue, actions }) {
  const trimmedName = String(name || '').trim()
  if (!trimmedName) throw new ActionError('err.nameRequired', 400)
  if (!triggerDeviceId || !triggerCode) throw new ActionError('err.automationTriggerRequired', 400)
  validateActions(actions)

  const id = newId()
  const now = new Date().toISOString()
  statements.insertRule.run(
    id, trimmedName, enabled === false ? 0 : 1, triggerDeviceId, triggerCode,
    String(triggerValue), JSON.stringify(actions), now, now
  )
  logAudit('automations.rule.create', { target: id, detail: trimmedName })
  return getRule(id)
}

export function updateRule (id, updates) {
  const existing = requireRule(id)
  const name = updates.name !== undefined ? String(updates.name).trim() : existing.name
  if (!name) throw new ActionError('err.nameRequired', 400)
  const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled
  const triggerDeviceId = updates.triggerDeviceId !== undefined ? updates.triggerDeviceId : existing.trigger_device_id
  const triggerCode = updates.triggerCode !== undefined ? updates.triggerCode : existing.trigger_code
  const triggerValue = updates.triggerValue !== undefined ? String(updates.triggerValue) : existing.trigger_value
  const actions = updates.actions !== undefined ? updates.actions : JSON.parse(existing.actions)
  if (updates.actions !== undefined) validateActions(actions)

  statements.updateRule.run(
    name, enabled, triggerDeviceId, triggerCode, triggerValue, JSON.stringify(actions),
    new Date().toISOString(), id
  )
  logAudit('automations.rule.update', { target: id, detail: name })
  return getRule(id)
}

export function deleteRule (id) {
  requireRule(id)
  statements.deleteRule.run(id)
  log.info(`regra ${id} removida`)
  logAudit('automations.rule.delete', { target: id })
}

export function recordRun (ruleId, ok, detail) {
  try {
    statements.insertRun.run(ruleId, new Date().toISOString(), ok ? 1 : 0, detail || null)
    statements.pruneRuns.run(ruleId, ruleId, MAX_RUNS_PER_RULE)
  } catch (err) {
    log.error(`falha ao registrar execução da regra ${ruleId}`, err.message)
  }
}

export function listRuns (ruleId, limit = MAX_RUNS_PER_RULE) {
  requireRule(ruleId)
  return statements.listRuns.all(ruleId, limit).map((row) => ({
    ranAt: row.ran_at,
    ok: !!row.ok,
    detail: row.detail
  }))
}
