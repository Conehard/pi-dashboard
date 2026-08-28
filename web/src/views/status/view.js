import { actionButton, defineView, renderChecksBar, showActionResult } from '../../core/dom.js'
import { fmtDateTime, orDash } from '../../core/format.js'
import { t } from '../../core/i18n.js'

const TEMPLATE_URL = new URL('./template.html', import.meta.url)

const UPTIME_POLL_INTERVAL_MS = 15000

async function loadUptimeHistory (id, box) {
  box.innerHTML = `<p class="empty-row">${t('common.loading')}</p>`
  try {
    const res = await fetch(`/api/uptime/targets/${id}/history`)
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || t('status.loadHistoryFailed'))
    if (data.history.length === 0) {
      box.innerHTML = `<p class="empty-row">${t('status.noChecks')}</p>`
      return
    }
    box.innerHTML = ''
    data.history.forEach((check) => {
      const row = document.createElement('div')
      row.className = 'job-run'
      const header = document.createElement('div')
      header.className = 'job-run-header'
      const badge = document.createElement('span')
      badge.className = `state-badge ${check.ok ? 'state-running' : 'state-exited'}`
      badge.textContent = check.ok
        ? `${t('status.ok')}${check.latencyMs !== null && check.latencyMs !== undefined ? ` · ${check.latencyMs}ms` : ''}`
        : (check.error || t('tasks.job.failed'))
      const when = document.createElement('span')
      when.className = 'card-sub'
      when.textContent = fmtDateTime(check.checkedAt)
      header.append(badge, when)
      row.appendChild(header)
      box.appendChild(row)
    })
  } catch (err) {
    box.innerHTML = `<p class="empty-row">${err.message}</p>`
  }
}

async function toggleUptimeTargetEnabled (target) {
  try {
    const res = await fetch(`/api/uptime/targets/${target.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !target.enabled })
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    fetchUptimeTargets()
  } catch (err) {
    showActionResult(false, err.message)
  }
}

async function deleteUptimeTargetUI (target) {
  if (!confirm(t('status.confirmDelete', { name: target.name }))) return
  try {
    const res = await fetch(`/api/uptime/targets/${target.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    fetchUptimeTargets()
  } catch (err) {
    showActionResult(false, err.message)
  }
}

function renderUptimeTarget (target) {
  const section = document.createElement('section')
  section.className = 'panel'

  const header = document.createElement('div')
  header.className = 'project-header'

  const titleWrap = document.createElement('div')
  const h3 = document.createElement('h3')
  h3.textContent = target.name
  const sub = document.createElement('div')
  sub.className = 'card-sub'
  sub.textContent = `${target.checkType.toUpperCase()} · ${target.target} · ${t('status.everySeconds', { n: target.intervalSeconds })}`
  titleWrap.append(h3, sub)

  const actions = document.createElement('div')
  actions.className = 'project-actions'
  actions.appendChild(actionButton(
    target.enabled ? t('tasks.job.pause') : t('tasks.job.resume'),
    target.enabled ? 'btn-restart' : 'btn-start',
    () => toggleUptimeTargetEnabled(target)
  ))
  actions.appendChild(actionButton(t('status.edit'), 'btn-secondary', () => startEditUptimeTarget(target)))
  actions.appendChild(actionButton(t('tasks.job.delete'), 'btn-remove', () => deleteUptimeTargetUI(target)))

  header.append(titleWrap, actions)
  section.appendChild(header)

  const statusRow = document.createElement('div')
  statusRow.className = 'job-status-row'

  const dot = document.createElement('span')
  dot.className = !target.lastCheck ? 'dot dot-unknown' : `dot ${target.lastCheck.ok ? 'dot-ok' : 'dot-error'}`
  statusRow.appendChild(dot)

  const statusText = document.createElement('span')
  statusText.className = 'card-sub'
  if (!target.lastCheck) {
    statusText.textContent = t('status.never')
  } else {
    const when = fmtDateTime(target.lastCheck.checkedAt)
    statusText.textContent = target.lastCheck.ok
      ? `${t('status.ok')} · ${target.lastCheck.latencyMs}ms · ${when}`
      : `${t('tasks.job.failed')} (${target.lastCheck.error || '--'}) · ${when}`
  }
  statusRow.appendChild(statusText)

  if (!target.enabled) {
    const pausedBadge = document.createElement('span')
    pausedBadge.className = 'state-badge state-other'
    pausedBadge.textContent = t('tasks.job.paused')
    statusRow.appendChild(pausedBadge)
  }
  section.appendChild(statusRow)

  const summaryRow = document.createElement('div')
  summaryRow.className = 'card-sub uptime-summary-row'
  const pct24 = orDash(target.uptimePercent24h, (v) => `${v}%`)
  const pct7 = orDash(target.uptimePercent7d, (v) => `${v}%`)
  summaryRow.textContent = t('status.uptimeSummary', { p24: pct24, p7: pct7 })
  section.appendChild(summaryRow)

  section.appendChild(renderChecksBar(target.recentChecks, 'checkedAt'))

  const historyBox = document.createElement('div')
  historyBox.className = 'job-history hidden'
  const historyToggle = actionButton(t('status.viewHistory'), 'btn-secondary', async () => {
    historyBox.classList.toggle('hidden')
    if (!historyBox.classList.contains('hidden') && !historyBox.dataset.loaded) {
      historyBox.dataset.loaded = 'true'
      await loadUptimeHistory(target.id, historyBox)
    }
  })
  section.append(historyToggle, historyBox)

  return section
}

function renderUptimeTargets (targets) {
  const container = document.getElementById('uptime-targets-container')
  if (targets.length === 0) {
    container.innerHTML = `<p class="empty-row">${t('status.none')}</p>`
    return
  }
  container.innerHTML = ''
  targets.forEach((t) => container.appendChild(renderUptimeTarget(t)))
}

async function fetchUptimeTargets () {
  try {
    const res = await fetch('/api/uptime/targets')
    const data = await res.json()
    if (data.ok) renderUptimeTargets(data.targets)
  } catch {
  }
}

function updateUptimeFormFields () {
  const type = document.getElementById('uptime-check-type').value
  document.getElementById('uptime-target').placeholder = type === 'http'
    ? t('status.targetPlaceholderHttp')
    : t('status.targetPlaceholderTcp')
  document.getElementById('uptime-expected-status').classList.toggle('hidden', type !== 'http')
}

let editingTargetId = null

function startEditUptimeTarget (target) {
  editingTargetId = target.id
  document.getElementById('uptime-form-title').textContent = t('status.editingTitle', { name: target.name })
  document.getElementById('uptime-name').value = target.name
  document.getElementById('uptime-check-type').value = target.checkType
  document.getElementById('uptime-target').value = target.target
  document.getElementById('uptime-expected-status').value = target.expectedStatus ?? ''
  document.getElementById('uptime-interval').value = target.intervalSeconds
  updateUptimeFormFields()
  document.getElementById('uptime-form-submit').textContent = t('status.saveChangesBtn')
  document.getElementById('uptime-form-cancel').classList.remove('hidden')
  document.getElementById('uptime-form').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function cancelEditUptimeTarget () {
  editingTargetId = null
  document.getElementById('uptime-form-title').textContent = t('status.newTarget.title')
  document.getElementById('uptime-form').reset()
  updateUptimeFormFields()
  document.getElementById('uptime-form-submit').textContent = t('status.addBtn')
  document.getElementById('uptime-form-cancel').classList.add('hidden')
  document.getElementById('uptime-form-error').classList.add('hidden')
}

function init () {
  document.getElementById('uptime-check-type').addEventListener('change', updateUptimeFormFields)
  updateUptimeFormFields()

  document.querySelectorAll('#uptime-form [data-interval-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('uptime-interval').value = btn.dataset.intervalPreset
    })
  })

  document.getElementById('uptime-form-cancel').addEventListener('click', cancelEditUptimeTarget)

  document.getElementById('uptime-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const errorBox = document.getElementById('uptime-form-error')
    errorBox.classList.add('hidden')

    const name = document.getElementById('uptime-name').value.trim()
    const checkType = document.getElementById('uptime-check-type').value
    const target = document.getElementById('uptime-target').value.trim()
    const expectedStatusRaw = document.getElementById('uptime-expected-status').value.trim()
    const intervalRaw = document.getElementById('uptime-interval').value.trim()

    const body = { name, checkType, target }
    if (expectedStatusRaw) body.expectedStatus = Number(expectedStatusRaw)
    if (intervalRaw) body.intervalSeconds = Number(intervalRaw)

    const isEdit = editingTargetId !== null

    try {
      const res = await fetch(
        isEdit ? `/api/uptime/targets/${editingTargetId}` : '/api/uptime/targets',
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      )
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      showActionResult(true, isEdit ? t('status.updatedOk', { name }) : t('status.addedOk', { name }))
      if (isEdit) cancelEditUptimeTarget()
      else {
        event.target.reset()
        updateUptimeFormFields()
      }
      fetchUptimeTargets()
    } catch (err) {
      errorBox.textContent = err.message
      errorBox.classList.remove('hidden')
    }
  })

  fetchUptimeTargets()
  setInterval(fetchUptimeTargets, UPTIME_POLL_INTERVAL_MS)

  window.addEventListener('pd-lang-changed', () => {
    fetchUptimeTargets()
    updateUptimeFormFields()
  })
}

defineView('pd-view-status', TEMPLATE_URL, init)
