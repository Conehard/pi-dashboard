import { actionButton, showActionResult, defineView } from '../../core/dom.js'
import { t, getLanguage, setLanguage } from '../../core/i18n.js'
import { runBackupNow, toggleBackupsList } from '../docker/view.js'
import { fmtDateTime } from '../../core/format.js'

const TEMPLATE_URL = new URL('./template.html', import.meta.url)

const CARD_PREF_KEY = 'pi-dashboard:cardPrefs'
const DEFAULT_CARD_PREFS = { cpu: true, temp: true, mem: true, uptime: true, network: true, internet: true }

function loadCardPrefs () {
  try {
    const raw = localStorage.getItem(CARD_PREF_KEY)
    return raw ? { ...DEFAULT_CARD_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_CARD_PREFS }
  } catch {
    return { ...DEFAULT_CARD_PREFS }
  }
}

let cardPrefs = loadCardPrefs()

function applyCardPrefs () {
  document.querySelectorAll('.cards-grid [data-card]').forEach((card) => {
    card.classList.toggle('hidden', cardPrefs[card.dataset.card] === false)
  })
  document.querySelectorAll('#view-settings input[data-toggle-card]').forEach((input) => {
    input.checked = cardPrefs[input.dataset.toggleCard] !== false
  })
}

let notifEls = null
let notifBotConfigured = false

function setNotifBotFormVisible (visible) {
  notifEls.botForm.classList.toggle('hidden', !visible)
  notifEls.botCancelBtn.classList.toggle('hidden', !(visible && notifBotConfigured))
  notifEls.botError.classList.add('hidden')
  if (!visible) notifEls.botForm.reset()
}

function renderNotifRoute (meta, route) {
  const box = document.createElement('div')
  box.className = 'job-run job-form'

  const header = document.createElement('div')
  header.className = 'job-run-header'

  const toggleLabel = document.createElement('label')
  toggleLabel.className = 'settings-toggle notif-route-toggle'

  const toggleInput = document.createElement('input')
  toggleInput.type = 'checkbox'
  toggleInput.className = 'switch-input'
  toggleInput.checked = route.enabled

  const toggleSwitch = document.createElement('span')
  toggleSwitch.className = 'switch'

  const toggleTextWrap = document.createElement('span')
  toggleTextWrap.className = 'settings-toggle-label'
  const title = document.createElement('span')
  title.className = 'settings-toggle-title'
  title.textContent = meta.label
  const desc = document.createElement('span')
  desc.className = 'settings-toggle-desc'
  desc.textContent = route.configured
    ? t('settings.notif.routeDescConfigured', { chatIdPreview: route.chatIdPreview, date: fmtDateTime(route.updatedAt) }) +
      (route.label ? t('settings.notif.routeDescLabelSuffix', { label: route.label }) : '')
    : t('settings.notif.noChatConfigured')
  toggleTextWrap.append(title, desc)

  toggleLabel.append(toggleInput, toggleSwitch, toggleTextWrap)
  header.appendChild(toggleLabel)
  box.appendChild(header)

  const formRow = document.createElement('div')
  formRow.className = 'job-form-row'

  const chatInput = document.createElement('input')
  chatInput.type = 'text'
  chatInput.placeholder = route.configured
    ? t('settings.notif.newChatPlaceholder')
    : t('settings.notif.chatIdPlaceholder')

  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.placeholder = t('settings.notif.labelPlaceholder')
  labelInput.value = route.label || ''

  formRow.append(chatInput, labelInput)

  let thresholdInput = null
  if (meta.hasThreshold) {
    thresholdInput = document.createElement('input')
    thresholdInput.type = 'number'
    thresholdInput.min = '1'
    thresholdInput.max = '99'
    thresholdInput.placeholder = t('settings.notif.thresholdPlaceholder')
    thresholdInput.className = 'notif-threshold-input'
    thresholdInput.value = route.threshold !== null && route.threshold !== undefined ? route.threshold : ''
    formRow.appendChild(thresholdInput)
  }

  const errorBox = document.createElement('div')
  errorBox.className = 'banner-error hidden'

  const saveBtn = actionButton(t('common.save'), 'btn-start', async () => {
    errorBox.classList.add('hidden')
    const body = { label: labelInput.value, enabled: toggleInput.checked }
    if (chatInput.value.trim()) body.chatId = chatInput.value.trim()
    if (thresholdInput) body.threshold = thresholdInput.value === '' ? null : Number(thresholdInput.value)
    try {
      const res = await fetch(`/api/notifications/routes/${meta.key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      showActionResult(true, t('settings.notif.savedOk', { label: meta.label }))
      fetchNotifStatus()
    } catch (err) {
      errorBox.textContent = err.message
      errorBox.classList.remove('hidden')
    }
  })

  const testBtn = actionButton(t('settings.notif.test'), 'btn-logs', async () => {
    errorBox.classList.add('hidden')
    try {
      const res = await fetch(`/api/notifications/test/${meta.key}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      showActionResult(true, t('settings.notif.testSent'))
    } catch (err) {
      errorBox.textContent = err.message
      errorBox.classList.remove('hidden')
    }
  })

  formRow.append(saveBtn, testBtn)
  box.append(formRow, errorBox)
  return box
}

function renderNotifRoutes (eventTypes, routes) {
  notifEls.routesList.innerHTML = ''
  const routesByType = new Map(routes.map((r) => [r.eventType, r]))
  eventTypes.forEach((meta) => {
    const route = routesByType.get(meta.key) || { eventType: meta.key, enabled: false, configured: false }
    notifEls.routesList.appendChild(renderNotifRoute(meta, route))
  })
}

async function fetchNotifStatus () {
  try {
    const res = await fetch('/api/notifications/status')
    const data = await res.json()
    if (!data.ok) return

    notifBotConfigured = data.botConfigured
    notifEls.botStatus.classList.toggle('hidden', !data.botConfigured)
    if (data.botConfigured) {
      notifEls.botUsername.textContent = data.botUsername ? `@${data.botUsername}` : t('settings.notif.botConnectedGeneric')
      setNotifBotFormVisible(false)
    } else {
      setNotifBotFormVisible(true)
    }

    renderNotifRoutes(data.eventTypes, data.routes)
  } catch {
  }
}

async function fetchSessions () {
  const box = document.getElementById('sessions-list')
  try {
    const res = await fetch('/api/auth/sessions')
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    renderSessions(data.sessions, box)
  } catch (err) {
    box.innerHTML = `<p class="empty-row">${t('settings.sessions.loadFailed', { error: err.message })}</p>`
  }
}

function renderSessions (sessions, box) {
  if (sessions.length === 0) {
    box.innerHTML = `<p class="empty-row">${t('settings.sessions.none')}</p>`
    return
  }

  const scroll = document.createElement('div')
  scroll.className = 'table-scroll'
  const table = document.createElement('table')
  table.className = 'data-table'
  table.innerHTML = `
    <thead><tr><th>${t('common.createdAt')}</th><th>${t('settings.sessions.lastSeen')}</th><th>${t('settings.sessions.expiresAt')}</th><th>${t('settings.sessions.ip')}</th><th>${t('common.actions')}</th></tr></thead>
    <tbody></tbody>
  `
  const tbody = table.querySelector('tbody')

  sessions.forEach((s) => {
    const row = document.createElement('tr')
    row.innerHTML = `
      <td>${fmtDateTime(s.createdAt)}</td>
      <td>${s.lastSeenAt ? fmtDateTime(s.lastSeenAt) : '--'}</td>
      <td>${fmtDateTime(s.expiresAt)}</td>
      <td>${s.ip || '--'}</td>
    `

    const actionsCell = document.createElement('td')
    actionsCell.className = 'actions-cell'
    if (s.isCurrent) {
      const badge = document.createElement('span')
      badge.className = 'state-badge state-running'
      badge.textContent = t('settings.sessions.current')
      actionsCell.appendChild(badge)
    } else {
      actionsCell.appendChild(actionButton(t('settings.sessions.revoke'), 'btn-remove', async () => {
        if (!window.confirm(t('settings.sessions.confirmRevoke'))) return
        try {
          const res = await fetch(`/api/auth/sessions/${s.id}`, { method: 'DELETE' })
          const data = await res.json()
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
          fetchSessions()
        } catch (err) {
          showActionResult(false, t('settings.sessions.revokeFailed', { error: err.message }))
        }
      }))
    }
    row.appendChild(actionsCell)
    tbody.appendChild(row)
  })

  scroll.appendChild(table)
  box.innerHTML = ''
  box.appendChild(scroll)
}

async function fetchAuditLog () {
  const box = document.getElementById('audit-list')
  try {
    const res = await fetch('/api/audit')
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    renderAuditLog(data.entries, box)
  } catch (err) {
    box.innerHTML = `<p class="empty-row">${t('settings.audit.loadFailed', { error: err.message })}</p>`
  }
}

function renderAuditLog (entries, box) {
  if (entries.length === 0) {
    box.innerHTML = `<p class="empty-row">${t('settings.audit.none')}</p>`
    return
  }

  const scroll = document.createElement('div')
  scroll.className = 'table-scroll'
  const table = document.createElement('table')
  table.className = 'data-table'
  table.innerHTML = `
    <thead><tr><th>${t('settings.audit.when')}</th><th>${t('settings.audit.action')}</th><th>${t('settings.audit.target')}</th><th>${t('settings.audit.detail')}</th></tr></thead>
    <tbody></tbody>
  `
  const tbody = table.querySelector('tbody')

  entries.forEach((e) => {
    const row = document.createElement('tr')
    row.innerHTML = `
      <td>${fmtDateTime(e.at)}</td>
      <td>${e.action}</td>
      <td>${e.target || '--'}</td>
      <td>${e.detail || '--'}</td>
    `
    tbody.appendChild(row)
  })

  scroll.appendChild(table)
  box.innerHTML = ''
  box.appendChild(scroll)
}

function init () {
  const languageSelect = document.getElementById('language-select')
  languageSelect.value = getLanguage()
  languageSelect.addEventListener('change', () => setLanguage(languageSelect.value))
  window.addEventListener('pd-lang-changed', () => { languageSelect.value = getLanguage() })

  document.querySelectorAll('#view-settings input[data-toggle-card]').forEach((input) => {
    input.addEventListener('change', () => {
      cardPrefs[input.dataset.toggleCard] = input.checked
      localStorage.setItem(CARD_PREF_KEY, JSON.stringify(cardPrefs))
      applyCardPrefs()
    })
  })

  applyCardPrefs()
  window.addEventListener('pd-system-update', applyCardPrefs, { once: true })

  document.getElementById('credentials-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const errorBox = document.getElementById('credentials-error')
    errorBox.classList.add('hidden')

    const currentPassword = document.getElementById('cred-current-password').value
    const newUsername = document.getElementById('cred-new-username').value.trim()
    const newPassword = document.getElementById('cred-new-password').value

    try {
      const res = await fetch('/api/auth/change-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newUsername, newPassword })
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      location.reload()
    } catch (err) {
      errorBox.textContent = err.message
      errorBox.classList.remove('hidden')
    }
  })

  notifEls = {
    botStatus: document.getElementById('notif-bot-status'),
    botUsername: document.getElementById('notif-bot-username'),
    botChangeBtn: document.getElementById('notif-bot-change-btn'),
    botRemoveBtn: document.getElementById('notif-bot-remove-btn'),
    botForm: document.getElementById('notif-bot-form'),
    botCancelBtn: document.getElementById('notif-bot-cancel-btn'),
    botTokenInput: document.getElementById('notif-bot-token'),
    botPasswordInput: document.getElementById('notif-bot-password'),
    botRevealBtn: document.getElementById('notif-bot-reveal-btn'),
    botError: document.getElementById('notif-bot-error'),
    routesList: document.getElementById('notif-routes-list')
  }

  notifEls.botRevealBtn.addEventListener('click', () => {
    const revealed = notifEls.botTokenInput.type === 'text'
    notifEls.botTokenInput.type = revealed ? 'password' : 'text'
    notifEls.botRevealBtn.textContent = revealed ? t('common.show') : t('common.hide')
  })

  notifEls.botChangeBtn.addEventListener('click', () => setNotifBotFormVisible(true))
  notifEls.botCancelBtn.addEventListener('click', () => setNotifBotFormVisible(false))

  notifEls.botRemoveBtn.addEventListener('click', async () => {
    if (!confirm(t('settings.notif.confirmRemove'))) return
    const currentPassword = prompt(t('settings.notif.promptPassword'))
    if (!currentPassword) return
    try {
      const res = await fetch('/api/notifications/bot', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword })
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      showActionResult(true, t('settings.notif.removedOk'))
      fetchNotifStatus()
    } catch (err) {
      showActionResult(false, err.message)
    }
  })

  notifEls.botForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    notifEls.botError.classList.add('hidden')
    const token = notifEls.botTokenInput.value.trim()
    const currentPassword = notifEls.botPasswordInput.value

    try {
      const res = await fetch('/api/notifications/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, currentPassword })
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      showActionResult(true, t('settings.notif.connectedOk', { username: data.botUsername }))
      fetchNotifStatus()
    } catch (err) {
      notifEls.botError.textContent = err.message
      notifEls.botError.classList.remove('hidden')
    }
  })

  fetchNotifStatus()
  fetchSessions()
  fetchAuditLog()

  document.getElementById('self-backup-now-btn').addEventListener('click', () => {
    runBackupNow('pi-dashboard', document.getElementById('self-backup-list'))
  })
  document.getElementById('self-backup-view-btn').addEventListener('click', () => {
    toggleBackupsList('pi-dashboard', document.getElementById('self-backup-list'))
  })

  window.addEventListener('pd-lang-changed', () => {
    fetchNotifStatus()
    fetchSessions()
    fetchAuditLog()
  })
}

defineView('pd-view-settings', TEMPLATE_URL, init)
