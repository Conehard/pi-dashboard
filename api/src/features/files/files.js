// File manager (#files screen) - browse/open/download/upload/rename/move/delete files on the host's
// disks. Everything here works on a "root" + a path relative to it, never a raw absolute path from the
// client - every path is resolved and checked (symlinks included, via realpath) to still be inside its
// root before anything touches it.
//
// Roots come from two places (see the /host/files mounts in docker-compose.yml):
// - internal: FILES_INTERNAL_DIR (the host user's home on the SD card by default) - one fixed root.
// - external: every real mount point under FILES_EXTERNAL_DIRS (host /mnt and /media), discovered from
//   this process's own mountinfo on every request - those mounts use rslave propagation, so a disk
//   plugged in and mounted on the host after this container started shows up here too, no restart.
//   Only real mount points count, not plain folders: a folder under /mnt with no disk mounted on it
//   lives on the SD card, and listing it as an "external disk" would silently write there instead.
import { promises as fs, createWriteStream, readFileSync } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { pipeline } from 'stream/promises'
import express from 'express'
import { ActionError } from '../../lib/errors.js'
import { logAudit } from '../audit/audit.js'

const INTERNAL_DIR = process.env.FILES_INTERNAL_DIR || '/host/files/home'
const EXTERNAL_DIRS = (process.env.FILES_EXTERNAL_DIRS || '/host/files/mnt,/host/files/media')
  .split(',').map((s) => s.trim()).filter(Boolean)
const INTERNAL_ROOT_ID = 'internal'
const MAX_NAME_BYTES = 255
const UPLOAD_TEMP_PREFIX = '.pd-upload-'

// Served inline (opened in a browser tab) as their real type - anything the browser can render itself.
const INLINE_TYPE_RE = /^(image|video|audio)\/|^application\/pdf$/
// Served inline as text/plain (source shown, never rendered/executed - an .html file opens as its code).
const TEXT_TYPE_RE = /^text\/|^application\/(json|xml|javascript|x-sh|x-yaml|yaml|toml|x-httpd-php|sql)$/
const TEXT_EXTENSIONS = new Set([
  '.log', '.conf', '.cfg', '.ini', '.env', '.yml', '.yaml', '.toml', '.md', '.txt', '.sh', '.py', '.js',
  '.mjs', '.ts', '.json', '.csv', '.service', '.timer', '.properties', '.gitignore', '.dockerignore'
])

// --- roots ---

function decodeMountPath (raw) {
  return raw.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
}

function listMountPoints () {
  try {
    return readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => decodeMountPath(line.split(' ')[4]))
  } catch {
    return []
  }
}

async function statfsSafe (dir) {
  try {
    const s = await fs.statfs(dir)
    return { totalBytes: s.blocks * s.bsize, availableBytes: s.bavail * s.bsize }
  } catch {
    return { totalBytes: null, availableBytes: null }
  }
}

function discoverRoots () {
  const roots = [{ id: INTERNAL_ROOT_ID, label: 'home', kind: 'internal', dir: INTERNAL_DIR }]
  const mounts = listMountPoints()
  for (const base of EXTERNAL_DIRS) {
    const found = mounts.filter((m) => m.startsWith(base + '/'))
    // Only the outermost mount points - a mount nested inside another external disk is just a folder
    // of that disk from the user's point of view, reachable by browsing into it.
    const outermost = found.filter((m) => !found.some((other) => other !== m && m.startsWith(other + '/')))
    for (const dir of outermost.sort()) {
      const rel = path.relative(path.dirname(base), dir) // e.g. "mnt/touro"
      roots.push({ id: rel, label: path.basename(dir), kind: 'external', dir })
    }
  }
  return roots
}

export async function listRoots () {
  return Promise.all(discoverRoots().map(async (r) => ({
    id: r.id,
    label: r.label,
    kind: r.kind,
    ...(await statfsSafe(r.dir))
  })))
}

function findRoot (rootId) {
  const root = discoverRoots().find((r) => r.id === rootId)
  if (!root) throw new ActionError('err.filesRootNotFound', 404, { root: rootId })
  return root
}

// --- path resolution ---

function cleanRelative (rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new ActionError('err.filesInvalidPath', 400)
  // Leading "/" makes normalize() swallow any "..", so the result can never climb above the root.
  return path.posix.normalize('/' + rel).replace(/^\/+|\/+$/g, '')
}

function validateName (name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') ||
      name.includes('\0') || Buffer.byteLength(name) > MAX_NAME_BYTES) {
    throw new ActionError('err.filesInvalidName', 400)
  }
  return name
}

function isInside (parent, child) {
  return child === parent || child.startsWith(parent + path.sep)
}

async function realRoot (root) {
  try {
    return await fs.realpath(root.dir)
  } catch {
    throw new ActionError('err.filesRootNotFound', 404, { root: root.id })
  }
}

function notFoundOr (err) {
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return new ActionError('err.filesNotFound', 404)
  return err
}

// Full path of an existing entry, following symlinks - for reading (list/download). Refuses a symlink
// pointing outside its root.
async function resolveExisting (rootId, rel) {
  const root = findRoot(rootId)
  const rootReal = await realRoot(root)
  let real
  try {
    real = await fs.realpath(path.join(rootReal, cleanRelative(rel)))
  } catch (err) {
    throw notFoundOr(err)
  }
  if (!isInside(rootReal, real)) throw new ActionError('err.filesOutsideRoot', 403)
  return { root, rootReal, real }
}

// Path of the entry ITSELF (a symlink stays a symlink, not its target) - for rename/move/delete. Only
// its parent directory is resolved/checked, then the last name is appended as-is.
async function resolveEntry (rootId, rel) {
  const clean = cleanRelative(rel)
  if (!clean) throw new ActionError('err.filesRootImmutable', 400)
  const parent = await resolveExisting(rootId, path.posix.dirname(clean) === '.' ? '' : path.posix.dirname(clean))
  const full = path.join(parent.real, path.posix.basename(clean))
  try {
    await fs.lstat(full)
  } catch (err) {
    throw notFoundOr(err)
  }
  return { ...parent, full }
}

async function resolveDir (rootId, rel) {
  const resolved = await resolveExisting(rootId, rel)
  const stat = await fs.stat(resolved.real)
  if (!stat.isDirectory()) throw new ActionError('err.filesNotADirectory', 400)
  return resolved
}

async function exists (p) {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

function fsError (err) {
  if (err instanceof ActionError) return err
  if (err.code === 'EACCES' || err.code === 'EPERM') return new ActionError('err.filesPermissionDenied', 403)
  if (err.code === 'ENOSPC') return new ActionError('err.filesNoSpace', 507)
  if (err.code === 'EROFS') return new ActionError('err.filesReadOnly', 403)
  if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST') return new ActionError('err.filesAlreadyExists', 409)
  if (err.code === 'ENOENT') return new ActionError('err.filesNotFound', 404)
  return new ActionError('err.filesOperationFailed', 500, { error: err.message })
}

function auditTarget (rootId, rel) {
  return `${rootId}:/${cleanRelative(rel)}`
}

// --- reading ---

function openMode (name, isFile) {
  if (!isFile) return null
  const type = express.static.mime.lookup(name)
  if (INLINE_TYPE_RE.test(type)) return 'inline'
  if (TEXT_TYPE_RE.test(type) || TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) return 'text'
  return null
}

export async function listDir (rootId, rel) {
  const { real } = await resolveDir(rootId, rel)
  let dirents
  try {
    dirents = await fs.readdir(real, { withFileTypes: true })
  } catch (err) {
    throw fsError(err)
  }

  const entries = await Promise.all(dirents
    .filter((d) => !d.name.startsWith(UPLOAD_TEMP_PREFIX))
    .map(async (d) => {
      const full = path.join(real, d.name)
      let stat = null
      try {
        stat = await fs.stat(full) // follows symlinks, so a link to a folder behaves like a folder
      } catch { /* broken symlink - still listed, so it can be deleted */ }
      const type = stat ? (stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other') : 'other'
      return {
        name: d.name,
        type,
        symlink: d.isSymbolicLink(),
        sizeBytes: stat && type === 'file' ? stat.size : null,
        modifiedAt: stat ? stat.mtime.toISOString() : null,
        open: openMode(d.name, type === 'file')
      }
    }))

  entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir')
    ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : a.type === 'dir' ? -1 : 1)
  return { path: cleanRelative(rel), entries }
}

// Returns what the route needs to stream the file: its real path + the headers to send. `inline`
// only ever serves browser-safe types inline (see INLINE_TYPE_RE/TEXT_TYPE_RE) - everything else is
// forced to a download, and inline responses get a sandbox CSP so an uploaded HTML/SVG file opened
// from here can never run script with the dashboard's session.
export async function prepareDownload (rootId, rel, { inline } = {}) {
  const { real } = await resolveExisting(rootId, rel)
  const stat = await fs.stat(real)
  if (!stat.isFile()) throw new ActionError('err.filesNotAFile', 400)

  const name = path.basename(real)
  const mode = inline ? openMode(name, true) : null
  const encoded = encodeURIComponent(name)
  const asciiFallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const headers = { 'X-Content-Type-Options': 'nosniff' }
  headers['Content-Disposition'] = `${mode ? 'inline' : 'attachment'}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
  if (mode === 'text') headers['Content-Type'] = 'text/plain; charset=utf-8'
  // Chrome refuses to render a PDF under a sandbox CSP at all, and its PDF viewer is already isolated.
  if (mode && express.static.mime.lookup(name) !== 'application/pdf') headers['Content-Security-Policy'] = 'sandbox'
  return { real, headers }
}

// --- writing ---

export async function makeDir (rootId, rel, name) {
  const { real } = await resolveDir(rootId, rel)
  const target = path.join(real, validateName(name))
  try {
    await fs.mkdir(target)
  } catch (err) {
    throw fsError(err)
  }
  logAudit('files.mkdir', { target: auditTarget(rootId, path.posix.join(rel || '', name)) })
}

// Streams the raw request body into a temp file next to the destination, then renames it into place -
// a cancelled/failed upload never leaves a half-written file under the real name. Doesn't buffer
// anything in memory, so file size is limited only by the destination disk.
export async function uploadFile (rootId, rel, name, stream, { overwrite } = {}) {
  const { real } = await resolveDir(rootId, rel)
  const target = path.join(real, validateName(name))
  if (!overwrite && await exists(target)) throw new ActionError('err.filesAlreadyExists', 409)

  const temp = path.join(real, `${UPLOAD_TEMP_PREFIX}${crypto.randomBytes(6).toString('hex')}`)
  try {
    await pipeline(stream, createWriteStream(temp, { flags: 'wx' }))
    if (!overwrite && await exists(target)) throw new ActionError('err.filesAlreadyExists', 409)
    await fs.rename(temp, target)
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {})
    if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'ECONNRESET') throw new ActionError('err.filesUploadAborted', 400)
    throw fsError(err)
  }
  const { size } = await fs.stat(target)
  logAudit('files.upload', { target: auditTarget(rootId, path.posix.join(rel || '', name)), detail: `${size} bytes` })
  return { name, sizeBytes: size }
}

export async function renameEntry (rootId, rel, newName) {
  const { full } = await resolveEntry(rootId, rel)
  const target = path.join(path.dirname(full), validateName(newName))
  if (target === full) return
  // Case-only rename ("a.txt" -> "A.txt") on a case-insensitive filesystem (exFAT/NTFS USB disks) would
  // see the target as already existing - it's the same file, so let it through.
  if (await exists(target) && target.toLowerCase() !== full.toLowerCase()) throw new ActionError('err.filesAlreadyExists', 409)
  try {
    await fs.rename(full, target)
  } catch (err) {
    throw fsError(err)
  }
  logAudit('files.rename', { target: auditTarget(rootId, rel), detail: `→ ${newName}` })
}

async function moveOne (source, destDir) {
  const target = path.join(destDir, path.basename(source))
  if (target === source) return
  if (isInside(source, destDir)) throw new ActionError('err.filesMoveIntoItself', 400, { name: path.basename(source) })
  if (await exists(target)) throw new ActionError('err.filesTargetExists', 409, { name: path.basename(source) })
  try {
    await fs.rename(source, target)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    // Different disks - rename(2) can't cross filesystems, so copy then remove the original. Only
    // removes the source once the whole copy succeeded; a failed copy cleans up its partial target.
    try {
      await fs.cp(source, target, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false })
    } catch (copyErr) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {})
      throw copyErr
    }
    await fs.rm(source, { recursive: true, force: true })
  }
}

// `items`: [{ root, path }]. Moves each into destRoot/destPath, stopping at the first failure (earlier
// items stay moved - the UI reloads the listing either way, so it shows what actually happened).
export async function moveEntries (items, destRootId, destRel) {
  if (!Array.isArray(items) || items.length === 0) throw new ActionError('err.filesNothingSelected', 400)
  const dest = await resolveDir(destRootId, destRel)
  const moved = []
  for (const item of items) {
    const { full } = await resolveEntry(item.root, item.path)
    try {
      await moveOne(full, dest.real)
    } catch (err) {
      throw fsError(err)
    }
    moved.push(item.path)
    logAudit('files.move', { target: auditTarget(item.root, item.path), detail: `→ ${auditTarget(destRootId, destRel)}` })
  }
  return { moved: moved.length }
}

export async function deleteEntries (items) {
  if (!Array.isArray(items) || items.length === 0) throw new ActionError('err.filesNothingSelected', 400)
  // Resolve everything first, so an invalid item fails the whole request before anything is deleted.
  const resolved = []
  for (const item of items) resolved.push({ item, ...(await resolveEntry(item.root, item.path)) })
  for (const { item, full } of resolved) {
    try {
      await fs.rm(full, { recursive: true })
    } catch (err) {
      throw fsError(err)
    }
    logAudit('files.delete', { target: auditTarget(item.root, item.path) })
  }
  return { deleted: resolved.length }
}
