import { promises as fs } from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { createLogger } from '../../lib/logger.js'
import { ActionError } from '../../lib/errors.js'
import { logAudit } from '../audit/audit.js'
import { PROJECT_DIRS, getProjectDir } from './registry.js'

const log = createLogger('compose-actions')
const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

async function findComposeFile (dir) {
  for (const name of COMPOSE_FILENAMES) {
    const candidate = path.join(dir, name)
    try {
      await fs.access(candidate)
      return candidate
    } catch {
    }
  }
  return null
}

export async function listComposeProjects () {
  const projects = []
  for (const [name, dir] of PROJECT_DIRS) {
    const file = await findComposeFile(dir)
    if (file) projects.push({ name, dir, file })
  }
  return projects
}

async function getProject (project) {
  const dir = getProjectDir(project)
  if (!dir) {
    throw new ActionError('err.projectNotFoundOrNotMounted', 404, { project })
  }
  const file = await findComposeFile(dir)
  if (!file) {
    throw new ActionError('err.projectNoComposeFile', 404, { project, dir })
  }
  return { dir, file }
}

function spawnCompose (args, cwd) {
  return spawn('docker', ['compose', ...args], {
    cwd,
    env: { ...process.env, HOME: '/tmp', DOCKER_CONFIG: '/tmp/.docker' }
  })
}

function runComposeCapture (args, cwd) {
  return new Promise((resolve) => {
    const child = spawnCompose(args, cwd)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: err.message }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

export async function readComposeFile (project) {
  const { file } = await getProject(project)
  return fs.readFile(file, 'utf8')
}

export async function writeComposeFile (project, content) {
  const { dir, file } = await getProject(project)

  const tmpFile = path.join('/tmp', `compose-validate-${project}-${Date.now()}.yml`)
  await fs.writeFile(tmpFile, content, 'utf8')

  const { code, stderr } = await runComposeCapture(
    ['-f', tmpFile, '--project-directory', dir, 'config', '-q'],
    dir
  )
  await fs.unlink(tmpFile).catch(() => {})

  if (code !== 0) {
    throw new ActionError('err.composeFileInvalid', 400, { detail: stderr.trim() || '(sem saída)' })
  }

  try {
    await fs.writeFile(file, content, 'utf8')
  } catch (err) {
    throw new ActionError('err.composeFileSaveFailed', 500, { file, error: err.message })
  }

  log.info(`saved compose file for project ${project}`)
  logAudit('compose.file.save', { target: project })
}

const RUN_ACTIONS = {
  pull: ['pull'],
  up: ['up', '-d', '--remove-orphans'],
  down: ['down']
}

export async function runComposeAction (project, action, onLine) {
  const { dir } = await getProject(project)
  const args = RUN_ACTIONS[action]
  if (!args) {
    throw new ActionError('err.invalidComposeAction', 400, { action })
  }

  return new Promise((resolve) => {
    const child = spawnCompose(args, dir)
    const feed = (chunk) => {
      chunk.toString('utf8').split('\n').forEach((line) => {
        if (line.length) onLine(line)
      })
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.on('error', (err) => {
      onLine(`[erro ao executar "docker compose ${args.join(' ')}": ${err.message}]`)
      resolve(1)
    })
    child.on('close', (code) => {
      logAudit(`compose.${action}`, { target: project, detail: `exit code ${code}` })
      resolve(code)
    })
  })
}
