// Web terminal (#terminal screen) - an interactive shell, over a WebSocket (routes/terminal.routes.js), into
// either the host itself or any running container. Everything goes through the Docker socket already
// mounted for the rest of the app - no SSH server, no extra credentials:
//
// - container: a plain `docker exec -it <container> sh` (bash when the image has it).
// - host: a short-lived helper container (this API's own image, so nothing to pull) started with
//   --privileged --pid=host that runs `busybox nsenter -t 1` (built into Alpine) into every namespace of
//   the host's PID 1, then `su -l` to the host user that owns the home folder mounted for the Files
//   screen (uid 1000 on a standard Pi). It is removed as soon as the terminal closes, and any leftover
//   from a crashed API is cleaned up on startup (cleanupOrphanHelpers).
//
// This is exactly the power docker.sock already grants (see the socket mount comment in
// docker-compose.yml) - nothing new is unlocked, it's just made interactive. It can still be switched off
// entirely with TERMINAL_ENABLED=false.
import os from 'node:os'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { docker } from '../../lib/docker-client.js'
import { ActionError } from '../../lib/errors.js'
import { createLogger } from '../../lib/logger.js'
import { logAudit } from '../audit/audit.js'

const log = createLogger('terminal')

export const HOST_TARGET = 'host'
const HELPER_LABEL = 'pi-dashboard.terminal'
const SELF_CONTAINER_NAME = 'pi-dashboard-api'
// Mounted for the Files screen (docker-compose.yml) - its owner is the host user to log in as.
const HOST_HOME_MOUNT = '/host/files/home'

const CONTAINER_SHELL = 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'
const HOST_SHELL = [
  'u="$TERMINAL_HOST_USER"',
  '[ -n "$u" ] || u=$(getent passwd "$HOST_UID" 2>/dev/null | cut -d: -f1)',
  '[ -n "$u" ] || u=$(awk -F: -v id="$HOST_UID" \'$3 == id { print $1; exit }\' /etc/passwd)',
  '[ -n "$u" ] || u=root',
  'exec su -l "$u"'
].join('\n')

export function isTerminalEnabled () {
  return (process.env.TERMINAL_ENABLED || 'true').toLowerCase() !== 'false'
}

function assertEnabled () {
  if (!isTerminalEnabled()) throw new ActionError('err.terminalDisabled', 403)
}

// Each resize is its own HTTP call to Docker, so two sent back to back (the initial size, then the browser
// refitting right away) can land out of order and leave the shell at the stale size - chained instead.
function serialResize (resizeFn) {
  let chain = Promise.resolve()
  return (cols, rows) => {
    chain = chain.then(() => resizeFn({ w: cols, h: rows })).catch(() => { })
    return chain
  }
}

function clampSize (value, fallback, max) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback
}

export async function listTargets () {
  assertEnabled()
  const containers = await docker.listContainers({ filters: { status: ['running'] } })
  return [
    { id: HOST_TARGET, kind: 'host', name: os.hostname() },
    ...containers
      .filter((c) => !(c.Labels && c.Labels[HELPER_LABEL]))
      .map((c) => ({ id: c.Id, kind: 'container', name: (c.Names[0] || c.Id).replace(/^\//, '') }))
      .sort((a, b) => a.name.localeCompare(b.name))
  ]
}

async function ownImage () {
  // A container's hostname defaults to its own short id - the name is only a fallback in case someone
  // set `hostname:` in compose.
  for (const ref of [os.hostname(), SELF_CONTAINER_NAME]) {
    try {
      return (await docker.getContainer(ref).inspect()).Image
    } catch { }
  }
  throw new ActionError('err.terminalNoImage', 500)
}

async function hostUid () {
  try {
    return String((await fs.stat(HOST_HOME_MOUNT)).uid)
  } catch {
    return '1000'
  }
}

async function openContainerSession (id, size) {
  const container = docker.getContainer(id)
  let name
  try {
    const info = await container.inspect()
    if (!info.State.Running) throw new ActionError('err.terminalNotRunning', 409)
    name = info.Name.replace(/^\//, '')
  } catch (err) {
    if (err.statusCode === 404) throw new ActionError('err.containerNotFound', 404)
    throw err
  }
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', CONTAINER_SHELL],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ['TERM=xterm-256color']
  })
  const stream = await exec.start({ hijack: true, stdin: true, Tty: true })
  const resize = serialResize((opts) => exec.resize(opts))
  resize(size.cols, size.rows)
  return {
    name,
    stream,
    resize,
    // Closing our end of the hijacked connection sends EOF to the shell, which exits on its own.
    close: async () => { stream.destroy() }
  }
}

async function openHostSession (size) {
  const container = await docker.createContainer({
    name: `pi-dashboard-terminal-${crypto.randomBytes(4).toString('hex')}`,
    Image: await ownImage(),
    User: 'root',
    Entrypoint: ['busybox', 'nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', '/bin/sh', '-c', HOST_SHELL],
    Cmd: [],
    Env: ['TERM=xterm-256color', `HOST_UID=${await hostUid()}`, `TERMINAL_HOST_USER=${process.env.TERMINAL_HOST_USER || ''}`],
    Labels: { [HELPER_LABEL]: '1' },
    Tty: true,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Privileged: true,
      PidMode: 'host',
      NetworkMode: 'host',
      AutoRemove: true
    }
  })
  let stream
  try {
    stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true })
    await container.start()
  } catch (err) {
    await container.remove({ force: true }).catch(() => { })
    throw err
  }
  const resize = serialResize((opts) => container.resize(opts))
  resize(size.cols, size.rows)
  return {
    name: os.hostname(),
    stream,
    resize,
    close: async () => {
      stream.destroy()
      await container.remove({ force: true }).catch(() => { })
    }
  }
}

export async function openSession (target, { cols, rows } = {}) {
  assertEnabled()
  const size = { cols: clampSize(cols, 80, 500), rows: clampSize(rows, 24, 200) }
  const session = target === HOST_TARGET
    ? await openHostSession(size)
    : await openContainerSession(String(target || ''), size)
  log.info(`terminal opened on ${session.name}`)
  logAudit('terminal.open', { target: target === HOST_TARGET ? `host (${session.name})` : session.name })
  return session
}

export async function cleanupOrphanHelpers () {
  if (!isTerminalEnabled()) return
  try {
    const leftovers = await docker.listContainers({ all: true, filters: { label: [HELPER_LABEL] } })
    for (const c of leftovers) {
      await docker.getContainer(c.Id).remove({ force: true }).catch(() => { })
    }
    if (leftovers.length > 0) log.info(`removed ${leftovers.length} leftover terminal helper container(s)`)
  } catch (err) {
    log.error('failed to clean up terminal helper containers', err.message)
  }
}
