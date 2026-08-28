import { promises as fs } from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { createLogger } from '../../lib/logger.js'
import { ActionError } from '../../lib/errors.js'
import { logAudit } from '../audit/audit.js'

const log = createLogger('compose-actions')

const OVERRIDE_FILE = process.env.COMPOSE_OVERRIDE_FILE || null
const PROJECT_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/

function parseProjectRegistry (raw) {
  const map = new Map()
  ;(raw || '').split(',').map(s => s.trim()).filter(Boolean).forEach((pair) => {
    const idx = pair.indexOf('=')
    if (idx <= 0) return
    const name = pair.slice(0, idx).trim()
    const dir = pair.slice(idx + 1).trim()
    if (name && dir) map.set(name, dir)
  })
  return map
}

export const PROJECT_DIRS = parseProjectRegistry(process.env.COMPOSE_PROJECTS)

export function getProjectDir (project) {
  return PROJECT_DIRS.get(project) || null
}

function buildOverrideDoc (registry) {
  if (registry.size === 0) {
    return { services: { 'pi-dashboard-api': {} } }
  }

  const volumes = []
  for (const [, dir] of registry) {
    const file = path.join(dir, 'docker-compose.yml')
    volumes.push(`${dir}:${dir}:ro`)
    volumes.push(`${file}:${file}`)
  }

  return {
    services: {
      'pi-dashboard-api': {
        environment: {
          COMPOSE_PROJECTS: Array.from(registry.entries()).map(([name, dir]) => `${name}=${dir}`).join(',')
        },
        volumes
      }
    }
  }
}

const OVERRIDE_FILE_HEADER =
  '# Generated and maintained by the pi-dashboard docker-compose management\n' +
  '# screen (api/src/features/compose/registry.js registerProject/unregisterProject).\n' +
  '# Manual edits here may get overwritten the next time a project is\n' +
  '# added or removed via the UI - for mounts the UI should never touch,\n' +
  '# use docker-compose.yml instead of this file.\n'

async function readRegistryFromFile () {
  if (!OVERRIDE_FILE) return null

  let raw
  try {
    raw = await fs.readFile(OVERRIDE_FILE, 'utf8')
  } catch {
    return null
  }

  let doc
  try {
    doc = yaml.load(raw)
  } catch (err) {
    throw new ActionError('err.overrideFileInvalidYaml', 500, { file: OVERRIDE_FILE, error: err.message })
  }

  const envValue = doc && doc.services && doc.services['pi-dashboard-api'] &&
    doc.services['pi-dashboard-api'].environment &&
    doc.services['pi-dashboard-api'].environment.COMPOSE_PROJECTS
  return parseProjectRegistry(envValue || '')
}

async function writeRegistryToFile (registry) {
  if (!OVERRIDE_FILE) {
    throw new ActionError('err.overrideFileNotConfigured', 500)
  }
  const content = OVERRIDE_FILE_HEADER + yaml.dump(buildOverrideDoc(registry), { lineWidth: -1 })
  await fs.writeFile(OVERRIDE_FILE, content, 'utf8')
}

export async function getRegistryStatus () {
  const active = PROJECT_DIRS
  const desired = (await readRegistryFromFile()) || active

  const pendingAdd = []
  for (const [name, dir] of desired) {
    if (!active.has(name)) pendingAdd.push({ name, dir })
  }
  const pendingRemove = []
  for (const name of active.keys()) {
    if (!desired.has(name)) pendingRemove.push(name)
  }

  return {
    active: Array.from(active.entries()).map(([name, dir]) => ({ name, dir })),
    pendingAdd,
    pendingRemove,
    restartNeeded: pendingAdd.length > 0 || pendingRemove.length > 0
  }
}

export async function registerProject (name, hostDir) {
  if (!PROJECT_NAME_RE.test(name)) {
    throw new ActionError('err.invalidProjectName', 400)
  }
  if (typeof hostDir !== 'string' || !hostDir.startsWith('/') || hostDir.includes('\n') || hostDir.trim() !== hostDir) {
    throw new ActionError('err.pathMustBeAbsolute', 400)
  }
  const dir = hostDir.length > 1 ? hostDir.replace(/\/+$/, '') : hostDir

  const registry = (await readRegistryFromFile()) || new Map(PROJECT_DIRS)
  if (registry.has(name)) {
    throw new ActionError('err.projectAlreadyRegistered', 409, { name })
  }

  registry.set(name, dir)
  await writeRegistryToFile(registry)
  log.info(`registered project ${name} -> ${dir} (pending restart to apply)`)
  logAudit('compose.registry.register', { target: name, detail: dir })
}

export async function unregisterProject (name) {
  const registry = (await readRegistryFromFile()) || new Map(PROJECT_DIRS)
  if (!registry.has(name)) {
    throw new ActionError('err.projectNotRegistered', 404, { name })
  }
  registry.delete(name)
  await writeRegistryToFile(registry)
  log.info(`unregistered project ${name} (pending restart to apply)`)
  logAudit('compose.registry.unregister', { target: name })
}
