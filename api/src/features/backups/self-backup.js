import { promises as fs } from 'fs'
import path from 'path'
import { db, DATA_DIR } from '../../lib/db.js'
import { createLogger } from '../../lib/logger.js'
import { ActionError } from '../../lib/errors.js'
import { runTar } from './actions.js'
import { logAudit } from '../audit/audit.js'

const log = createLogger('self-backup-actions')
const BACKUP_ROOT = process.env.BACKUP_ROOT || '/backups'
const SELF_PROJECT_NAME = 'pi-dashboard'
const FILENAME_RE = /^[a-zA-Z0-9_.-]+\.tar\.gz$/

function timestamp () {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function selfBackupDir () {
  return path.join(BACKUP_ROOT, SELF_PROJECT_NAME)
}

async function pruneOldBackups (retentionDays) {
  const destDir = selfBackupDir()
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const removed = []

  let entries
  try {
    entries = await fs.readdir(destDir, { withFileTypes: true })
  } catch {
    return removed
  }

  for (const entry of entries) {
    if (!entry.isFile() || !FILENAME_RE.test(entry.name)) continue
    const filePath = path.join(destDir, entry.name)
    const stat = await fs.stat(filePath)
    if (stat.mtime.getTime() < cutoff) {
      await fs.unlink(filePath)
      removed.push(entry.name)
    }
  }

  return removed
}

export async function runSelfBackup ({ retentionDays } = {}) {
  const destDir = selfBackupDir()
  await fs.mkdir(destDir, { recursive: true })

  const snapshotName = `.snapshot-${Date.now()}.db`
  const snapshotPath = path.join(DATA_DIR, snapshotName)

  try {
    await db.backup(snapshotPath)
  } catch (err) {
    throw new ActionError('err.selfBackupSnapshotFailed', 500, { error: err.message })
  }

  const filename = `${SELF_PROJECT_NAME}-${timestamp()}.tar.gz`
  const destFile = path.join(destDir, filename)

  try {
    await runTar(['-czf', destFile, '-C', DATA_DIR, snapshotName])
  } catch (err) {
    await fs.unlink(snapshotPath).catch(() => {})
    throw new ActionError('err.selfBackupCompressFailed', 500, { error: err.message })
  }
  await fs.unlink(snapshotPath).catch((err) =>
    log.error('snapshot compressed but failed to remove the temp .db file', err.message)
  )

  const stat = await fs.stat(destFile)
  log.info(`self-backup created: ${filename} (${stat.size} bytes)`)

  let removed = []
  if (retentionDays && retentionDays > 0) {
    removed = await pruneOldBackups(retentionDays)
  }

  logAudit('backup.create', { target: SELF_PROJECT_NAME, detail: `${filename} (${stat.size} bytes)` })
  return { file: filename, sizeBytes: stat.size, removed }
}

export { SELF_PROJECT_NAME }
