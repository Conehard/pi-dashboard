import { Router } from 'express'
import { WebSocketServer } from 'ws'
import { requireAuth, getCookie, isSessionValid, SESSION_COOKIE } from '../features/auth/sessions.js'
import { asyncHandler } from '../middleware/async-handler.js'
import { listTargets, openSession, isTerminalEnabled } from '../features/terminal/terminal.js'
import { createLogger } from '../lib/logger.js'
import { resolveLanguage, t } from '../lib/i18n.js'

const log = createLogger('terminal-ws')
export const TERMINAL_WS_PATH = '/api/terminal/ws'
const PING_INTERVAL_MS = 30 * 1000
// Re-checked while the terminal is open, so logging out / revoking the session in Settings also closes
// any terminal it had open instead of leaving it running until the tab is closed.
const SESSION_RECHECK_MS = 60 * 1000

const router = Router()
router.use(requireAuth)

router.get('/targets', asyncHandler(async (req, res) => {
  res.json({ ok: true, targets: await listTargets() })
}))

export default router

// The session cookie is SameSite=lax, which still gets sent on a WebSocket handshake from any page on the
// same *site* (another port or subdomain of this host) - so the Origin must match the host the dashboard
// itself was loaded from (nginx forwards the browser's Host header for this path, see nginx.conf).
function isSameOrigin (req) {
  const origin = req.headers.origin
  if (!origin) return false
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function rejectUpgrade (socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function sendControl (ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
}

// Protocol: the server sends the shell's raw output as binary frames, and JSON text frames for control
// ({ type: 'ready', name } / { type: 'exit' } / { type: 'error', message }). The browser sends JSON text
// frames only: { type: 'input', data } for keystrokes and { type: 'resize', cols, rows }.
async function handleConnection (ws, req, url, token) {
  const lang = resolveLanguage(url.searchParams.get('lang') || req.headers['accept-language'])
  let session = null
  let closed = false

  const pending = []
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (!session) {
      pending.push(msg)
      return
    }
    handleMessage(msg)
  })

  function handleMessage (msg) {
    if (msg.type === 'input' && typeof msg.data === 'string') {
      session.stream.write(msg.data)
    } else if (msg.type === 'resize') {
      const cols = Math.floor(Number(msg.cols))
      const rows = Math.floor(Number(msg.rows))
      if (cols > 0 && rows > 0 && cols <= 500 && rows <= 200) session.resize(cols, rows)
    }
  }

  let alive = true
  ws.on('pong', () => { alive = true })
  const pingTimer = setInterval(() => {
    if (!alive) return ws.terminate()
    alive = false
    ws.ping()
  }, PING_INTERVAL_MS)
  const sessionTimer = setInterval(() => {
    if (!isSessionValid(token)) ws.close(4401, 'session expired')
  }, SESSION_RECHECK_MS)

  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(pingTimer)
    clearInterval(sessionTimer)
    if (session) session.close().catch(() => { })
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)

  try {
    session = await openSession(url.searchParams.get('target'), {
      cols: url.searchParams.get('cols'),
      rows: url.searchParams.get('rows')
    })
  } catch (err) {
    log.error('failed to open terminal', err.message)
    sendControl(ws, { type: 'error', message: t(lang, err.message, err.vars) })
    ws.close()
    return
  }
  if (closed) {
    session.close().catch(() => { })
    return
  }

  session.stream.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true })
  })
  session.stream.on('end', () => {
    sendControl(ws, { type: 'exit' })
    ws.close()
  })
  session.stream.on('error', () => ws.close())

  sendControl(ws, { type: 'ready', name: session.name })
  pending.splice(0).forEach(handleMessage)
}

export function attachTerminalWebSocket (server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== TERMINAL_WS_PATH) return rejectUpgrade(socket, 404, 'Not Found')
    if (!isTerminalEnabled()) return rejectUpgrade(socket, 403, 'Forbidden')
    const token = getCookie(req, SESSION_COOKIE)
    if (!isSessionValid(token)) return rejectUpgrade(socket, 401, 'Unauthorized')
    if (!isSameOrigin(req)) return rejectUpgrade(socket, 403, 'Forbidden')

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, req, url, token).catch((err) => {
        log.error('terminal connection failed', err.message)
        ws.close()
      })
    })
  })
}
