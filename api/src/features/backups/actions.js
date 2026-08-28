import { promises as fs } from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { createLogger } from '../../lib/logger.js'
import { ActionError } from '../../lib/errors.js'
import { t, DEFAULT_LANGUAGE } from '../../lib/i18n.js'
import { getProjectDir } from '../compose/registry.js'
import { logAudit } from '../audit/audit.js'

const log = createLogger('backup-actions')
const BACKUP_ROOT = process.env.BACKUP_ROOT || '/backups'
const FILENAME_RE = /^[a-zA-Z0-9_.-]+\.tar\.gz$/

function timestamp () {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function projectBackupDir (project) {
  return path.join(BACKUP_ROOT, project)
}

export function runTar (args) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args)
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `tar saiu com código ${code}`))
    })
  })
}

async function hasDataDir (project) {
  const dir = getProjectDir(project)
  if (!dir) return null
  const dataDir = path.join(dir, 'data')
  try {
    const stat = await fs.stat(dataDir)
    return stat.isDirectory() ? dir : null
  } catch {
    return null
  }
}

export async function runBackup (project, { retentionDays, lang } = {}) {
  const dir = await hasDataDir(project)
  if (dir === null) {
    const exists = getProjectDir(project) !== null
    if (!exists) {
      throw new ActionError('err.projectNotComposeManaged', 404, { project })
    }
    return { skipped: true, reason: t(lang || DEFAULT_LANGUAGE, 'msg.backupSkippedNoDataDir', { project }) }
  }

  const destDir = projectBackupDir(project)
  await fs.mkdir(destDir, { recursive: true })

  const filename = `${project}-${timestamp()}.tar.gz`
  const destFile = path.join(destDir, filename)

  try {
    await runTar(['-czf', destFile, '-C', dir, 'data'])
  } catch (err) {
    throw new ActionError('err.backupFailed', 500, { project, error: err.message })
  }

  const stat = await fs.stat(destFile)
  log.info(`backup created for ${project}: ${filename} (${stat.size} bytes)`)

  let removed = []
  if (retentionDays && retentionDays > 0) {
    removed = await pruneOldBackups(project, retentionDays)
  }

  logAudit('backup.create', { target: project, detail: `${filename} (${stat.size} bytes)` })
  return { file: filename, sizeBytes: stat.size, removed }
}

export async function listBackups (project) {
  const destDir = projectBackupDir(project)
  let entries
  try {
    entries = await fs.readdir(destDir, { withFileTypes: true })
  } catch {
    return []
  }

  const files = await Promise.all(
    entries
      .filter((e) => e.isFile() && FILENAME_RE.test(e.name))
      .map(async (e) => {
        const stat = await fs.stat(path.join(destDir, e.name))
        return { name: e.name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() }
      })
  )

  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function pruneOldBackups (project, retentionDays) {
  const destDir = projectBackupDir(project)
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

export function resolveBackupFile (project, filename) {
  if (!FILENAME_RE.test(filename)) {
    throw new ActionError('err.invalidBackupFilename', 400)
  }
  return path.join(projectBackupDir(project), filename)
}

export async function deleteBackup (project, filename) {
  const filePath = resolveBackupFile(project, filename)
  try {
    await fs.unlink(filePath)
  } catch (err) {
    if (err.code === 'ENOENT') throw new ActionError('err.backupNotFound', 404)
    throw new ActionError('err.backupDeleteFailed', 500, { error: err.message })
  }
  logAudit('backup.delete', { target: project, detail: filename })
}
