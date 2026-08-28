import { t, translateDom } from './i18n.js'
import { fmtDateTime } from './format.js'

export function defineView (tagName, templateUrl, init) {
  customElements.define(tagName, class extends HTMLElement {
    async connectedCallback () {
      try {
        const res = await fetch(templateUrl)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        this.innerHTML = await res.text()
      } catch (err) {
        this.innerHTML = `<p class="empty-row">${t('common.loadFailed', { error: err.message })}</p>`
        return
      }
      translateDom(this)
      init()
    }
  })
}

export function renderChecksBar (checks, atKey) {
  const bar = document.createElement('div')
  bar.className = 'uptime-bar'
  if (!checks || checks.length === 0) {
    bar.classList.add('uptime-bar--empty')
    return bar
  }
  checks.forEach((c) => {
    const tick = document.createElement('span')
    tick.className = `uptime-tick ${c.ok ? 'uptime-tick--ok' : 'uptime-tick--down'}`
    const when = fmtDateTime(c[atKey])
    tick.title = `${when} · ${c.ok ? t('status.ok') : t('tasks.job.failed')}${c.latencyMs !== null && c.latencyMs !== undefined ? ` · ${c.latencyMs}ms` : ''}`
    bar.appendChild(tick)
  })
  return bar
}

export function stateClass (state) {
  const normalized = (state || '').toLowerCase()
  if (normalized === 'running') return 'state-running'
  if (normalized === 'restarting') return 'state-restarting'
  if (normalized === 'paused') return 'state-other'
  if (normalized === 'exited' || normalized === 'dead') return 'state-exited'
  if (normalized === 'stopped') return 'state-stopped'
  return 'state-other'
}

export function actionButton (label, cls, handler) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `btn ${cls}`
  btn.textContent = label
  btn.addEventListener('click', handler)
  return btn
}

const connEls = {
  dot: document.getElementById('conn-dot'),
  label: document.getElementById('conn-label')
}

let lastConnState = 'unknown'

export function setConnectionState (state) {
  lastConnState = state
  connEls.dot.className = `dot dot-${state}`
  connEls.label.textContent = state === 'ok' ? t('common.online') : state === 'error' ? t('common.offline') : t('common.connecting')
}

window.addEventListener('pd-lang-changed', () => setConnectionState(lastConnState))

const actionResultEls = {
  banner: document.getElementById('action-banner'),
  ok: document.getElementById('action-ok')
}

export function showActionResult (ok, message) {
  if (ok) {
    actionResultEls.banner.classList.add('hidden')
    actionResultEls.ok.textContent = message
    actionResultEls.ok.classList.remove('hidden')
    setTimeout(() => actionResultEls.ok.classList.add('hidden'), 4000)
  } else {
    actionResultEls.ok.classList.add('hidden')
    actionResultEls.banner.textContent = message
    actionResultEls.banner.classList.remove('hidden')
  }
}
