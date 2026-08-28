import net from 'node:net'
import { getLastCheckedAt, recordCheck } from './checks.js'
import { listEnabledTargets } from './targets.js'
import { notify } from '../notifications/dispatch.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('uptime-checker')
const TICK_MS = Number(process.env.UPTIME_CHECK_TICK_MS) || 15000
const HTTP_TIMEOUT_MS = 10000
const TCP_TIMEOUT_MS = 5000

let timer = null
const targetState = new Map()

function tcpConnect (host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const timeoutHandle = setTimeout(() => {
      socket.destroy()
      reject(new Error('tempo esgotado ao conectar'))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timeoutHandle)
      socket.destroy()
      resolve()
    })
    socket.once('error', (err) => {
      clearTimeout(timeoutHandle)
      reject(err)
    })
  })
}

async function runCheck (target) {
  const startedAt = Date.now()
  let ok = false
  let error = null

  try {
    if (target.checkType === 'http') {
      const res = await fetch(target.target, { redirect: 'follow', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
      ok = target.expectedStatus ? res.status === target.expectedStatus : (res.status >= 200 && res.status < 300)
      if (!ok) error = `HTTP ${res.status}`
    } else {
      const [host, portStr] = target.target.split(':')
      await tcpConnect(host, Number(portStr), TCP_TIMEOUT_MS)
      ok = true
    }
  } catch (err) {
    ok = false
    error = err.message
  }

  const latencyMs = Date.now() - startedAt
  recordCheck(target.id, { ok, latencyMs, error })
  handleTransition(target, ok)
}

function handleTransition (target, ok) {
  const state = targetState.get(target.id) || { seeded: false, lastOk: null }
  if (state.seeded) {
    if (state.lastOk && !ok) {
      notify('uptime_down', {
        title: 'Uptime caiu',
        message: `"${target.name}" (${target.target}) parou de responder.`
      }).catch(() => {})
    } else if (!state.lastOk && ok) {
      notify('uptime_down', {
        title: 'Uptime recuperado',
        message: `"${target.name}" (${target.target}) voltou a responder.`
      }).catch(() => {})
    }
  }
  targetState.set(target.id, { seeded: true, lastOk: ok })
}

async function tickOnce () {
  let targets
  try {
    targets = listEnabledTargets()
  } catch (err) {
    log.error('failed to list targets', err.message)
    return
  }

  const currentIds = new Set(targets.map((t) => t.id))
  for (const id of targetState.keys()) {
    if (!currentIds.has(id)) targetState.delete(id)
  }

  const now = Date.now()
  for (const target of targets) {
    const last = getLastCheckedAt(target.id)
    const dueAt = last ? new Date(last).getTime() + target.intervalSeconds * 1000 : 0
    if (now >= dueAt) {
      runCheck(target).catch((err) => log.error(`check failed for target ${target.id}`, err.message))
    }
  }
}

export function startUptimeChecker () {
  if (timer) return
  tickOnce()
  timer = setInterval(tickOnce, TICK_MS)
  timer.unref()
  log.info(`uptime checker started (tick every ${TICK_MS}ms)`)
}
