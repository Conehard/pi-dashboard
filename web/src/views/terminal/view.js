// Terminal screen (#terminal) - an interactive shell on the host or inside a running container, over a
// WebSocket to the API (api/src/routes/terminal.routes.js has the message protocol). xterm.js is vendored
// into the image at /vendor/xterm/ (see web/Dockerfile) and only loaded the first time this screen is
// opened, so the rest of the dashboard never pays for it.
import { defineView } from '../../core/dom.js'
import { getLanguage, t } from '../../core/i18n.js'

const TEMPLATE_URL = new URL('./template.html', import.meta.url)
const TARGET_KEY = 'pi-dashboard:terminalTarget'
const HOST_TARGET = 'host'

let els = {}
let xtermLoad = null
let term = null
let fitAddon = null
let socket = null
let targets = []

function setStatus (text, state = '') {
  els.status.textContent = text
  els.status.dataset.state = state
}

function setConnected (connected) {
  els.connectBtn.classList.toggle('hidden', connected)
  els.disconnectBtn.classList.toggle('hidden', !connected)
  els.target.disabled = connected
  els.refreshBtn.disabled = connected
}

function targetLabel (target) {
  return target.kind === 'host'
    ? t('terminal.target.host', { name: target.name })
    : t('terminal.target.container', { name: target.name })
}

function readSavedTarget () {
  try { return localStorage.getItem(TARGET_KEY) } catch { return null }
}

function saveTarget (id) {
  try { localStorage.setItem(TARGET_KEY, id) } catch { }
}

async function loadTargets () {
  const previous = els.target.value || readSavedTarget() || HOST_TARGET
  try {
    const res = await fetch('/api/terminal/targets')
    const data = await res.json().catch(() => null)
    if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
    targets = data.targets
  } catch (err) {
    targets = []
    setStatus(t('common.loadFailed', { error: err.message }), 'error')
  }
  els.target.innerHTML = ''
  targets.forEach((target) => {
    const option = document.createElement('option')
    option.value = target.id
    option.textContent = targetLabel(target)
    els.target.appendChild(option)
  })
  els.target.value = targets.some((target) => target.id === previous) ? previous : (targets[0] ? targets[0].id : '')
  els.connectBtn.disabled = targets.length === 0
}

function loadXterm () {
  if (!xtermLoad) {
    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = '/vendor/xterm/xterm.css'
    document.head.appendChild(css)
    xtermLoad = Promise.all([
      import('/vendor/xterm/xterm.mjs'),
      import('/vendor/xterm/addon-fit.mjs')
    ]).catch((err) => {
      xtermLoad = null
      throw err
    })
  }
  return xtermLoad
}

async function ensureTerminal () {
  if (term) return term
  const [{ Terminal }, { FitAddon }] = await loadXterm()
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: {
      background: '#0a0d13',
      foreground: '#e9ecf3',
      cursor: '#4f9cf9',
      selectionBackground: 'rgba(79, 156, 249, 0.35)'
    }
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(els.screen)
  term.onData((data) => send({ type: 'input', data }))
  term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
  // Refits whenever the box changes size - including going from 0x0 (screen hidden) back to visible,
  // which is also when a resize made on another screen finally gets applied.
  new ResizeObserver(() => fit()).observe(els.screen)
  fit()
  return term
}

function fit () {
  if (!fitAddon || els.screen.offsetWidth === 0 || els.screen.offsetHeight === 0) return
  try { fitAddon.fit() } catch { }
}

function send (message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

async function connect () {
  const targetId = els.target.value
  if (!targetId || socket) return
  saveTarget(targetId)
  setStatus(t('terminal.status.connecting'), 'connecting')
  setConnected(true)
  try {
    await ensureTerminal()
  } catch (err) {
    setConnected(false)
    setStatus(t('terminal.status.loadFailed', { error: err.message }), 'error')
    return
  }
  term.reset()
  fit()

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const params = new URLSearchParams({ target: targetId, cols: term.cols, rows: term.rows, lang: getLanguage() })
  const ws = new WebSocket(`${protocol}//${location.host}/api/terminal/ws?${params}`)
  ws.binaryType = 'arraybuffer'
  socket = ws
  let failed = false

  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      term.write(new Uint8Array(event.data))
      return
    }
    let msg
    try { msg = JSON.parse(event.data) } catch { return }
    if (msg.type === 'ready') {
      const target = targets.find((item) => item.id === targetId)
      setStatus(t('terminal.status.connected', { name: target ? targetLabel(target) : msg.name }), 'ok')
      term.focus()
    } else if (msg.type === 'error') {
      failed = true
      setStatus(msg.message, 'error')
    } else if (msg.type === 'exit') {
      setStatus(t('terminal.status.exited'), '')
    }
  })

  ws.addEventListener('close', (event) => {
    if (socket !== ws) return
    socket = null
    setConnected(false)
    if (failed) return
    if (event.code === 4401) setStatus(t('terminal.status.sessionExpired'), 'error')
    else if (els.status.dataset.state === 'connecting') setStatus(t('terminal.status.failed'), 'error')
    else if (els.status.dataset.state === 'ok') setStatus(t('terminal.status.disconnected'), '')
    term.write(`\r\n\x1b[90m${t('terminal.closedLine')}\x1b[0m\r\n`)
  })
}

function disconnect () {
  if (socket) socket.close()
}

function init () {
  els = {
    target: document.getElementById('terminal-target'),
    refreshBtn: document.getElementById('terminal-refresh-btn'),
    connectBtn: document.getElementById('terminal-connect-btn'),
    disconnectBtn: document.getElementById('terminal-disconnect-btn'),
    status: document.getElementById('terminal-status'),
    screen: document.getElementById('terminal-screen')
  }
  setStatus(t('terminal.status.idle'))

  els.refreshBtn.addEventListener('click', loadTargets)
  els.connectBtn.addEventListener('click', connect)
  els.disconnectBtn.addEventListener('click', disconnect)
  els.target.addEventListener('change', () => saveTarget(els.target.value))

  // The target list is only fetched when the screen is actually opened (and each time it's reopened
  // while disconnected, so containers started meanwhile show up) - not on every dashboard load.
  const onRoute = () => {
    if (location.hash !== '#terminal') return
    if (!socket) loadTargets()
    loadXterm().catch(() => { })
    if (term) setTimeout(() => { fit(); term.focus() }, 0)
  }
  window.addEventListener('hashchange', onRoute)
  onRoute()

  window.addEventListener('pd-lang-changed', () => {
    const selected = els.target.value
    Array.from(els.target.options).forEach((option) => {
      const target = targets.find((item) => item.id === option.value)
      if (target) option.textContent = targetLabel(target)
    })
    els.target.value = selected
  })
}

defineView('pd-view-terminal', TEMPLATE_URL, init)
