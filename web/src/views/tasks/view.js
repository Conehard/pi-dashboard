import { actionButton, showActionResult, defineView } from '../../core/dom.js'
import { fmtDateTime } from '../../core/format.js'
import { t } from '../../core/i18n.js'
import { composeProjects } from '../docker/view.js'

const TEMPLATE_URL = new URL('./template.html', import.meta.url)

const JOBS_POLL_INTERVAL_MS = 15000

function actionSummary (action) {
  if (action.type === 'compose-update') return t('tasks.job.actionSummaryComposeUpdate', { project: action.project })
  if (action.type === 'docker-prune') return t('docker.maintenance.pruneBtn')
  if (action.type === 'backup') {
    return t('tasks.job.actionSummaryBackup', { project: action.project }) + (action.retentionDays ? t('tasks.job.retentionSuffix', { days: action.retentionDays }) : '')
  }
  if (action.type === 'self-backup') {
    return t('tasks.job.actionSummarySelfBackup') + (action.retentionDays ? t('tasks.job.retentionSuffix', { days: action.retentionDays }) : '')
  }
  return action.type
}

async function runJobNow (id) {
  try {
    const res = await fetch(`/api/scheduler/jobs/${id}/run`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    showActionResult(
      data.result.ok,
      data.result.ok ? t('tasks.job.runOk') : t('tasks.job.runFailedDetail', { error: data.result.error || t('tasks.job.seeHistory') })
    )
  } catch (err) {
    showActionResult(false, t('tasks.job.runFailed', { error: err.message }))
  } finally {
    fetchJobs()
  }
}

async function toggleJobEnabled (job) {
  try {
    const res = await fetch(`/api/scheduler/jobs/${job.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !job.enabled })
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
  } catch (err) {
    showActionResult(false, t('tasks.job.updateFailed', { error: err.message }))
  } finally {
    fetchJobs()
  }
}

async function deleteJobUI (job) {
  if (!window.confirm(t('tasks.job.confirmDelete', { name: job.name }))) return
  try {
    const res = await fetch(`/api/scheduler/jobs/${job.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    showActionResult(true, t('tasks.job.deletedOk', { name: job.name }))
  } catch (err) {
    showActionResult(false, t('tasks.job.deleteFailed', { error: err.message }))
  } finally {
    fetchJobs()
  }
}

function renderJobRun (run) {
  const row = document.createElement('div')
  row.className = 'job-run'

  const header = document.createElement('div')
  header.className = 'job-run-header'
  const badge = document.createElement('span')
  badge.className = `state-badge ${run.skipped ? 'state-restarting' : run.ok ? 'state-running' : 'state-exited'}`
  badge.textContent = run.skipped ? t('tasks.job.skipped') : run.ok ? t('tasks.job.success') : t('tasks.job.failed')
  const when = document.createElement('span')
  when.className = 'card-sub'
  when.textContent = fmtDateTime(run.startedAt)
  header.append(badge, when)
  row.appendChild(header)

  if (run.output) {
    const pre = document.createElement('pre')
    pre.className = 'logs-view job-run-output'
    pre.textContent = run.output
    row.appendChild(pre)
  }

  return row
}

function renderJob (job) {
  const section = document.createElement('section')
  section.className = 'panel'

  const header = document.createElement('div')
  header.className = 'project-header'

  const titleWrap = document.createElement('div')
  const h3 = document.createElement('h3')
  h3.textContent = job.name
  const sub = document.createElement('div')
  sub.className = 'card-sub'
  sub.textContent = `${job.schedule} · ${actionSummary(job.action)}`
  titleWrap.append(h3, sub)

  const actions = document.createElement('div')
  actions.className = 'project-actions'
  actions.appendChild(actionButton(t('tasks.job.runNow'), 'btn-start', () => runJobNow(job.id)))
  actions.appendChild(actionButton(
    job.enabled ? t('tasks.job.pause') : t('tasks.job.resume'),
    job.enabled ? 'btn-restart' : 'btn-start',
    () => toggleJobEnabled(job)
  ))
  actions.appendChild(actionButton(t('tasks.job.delete'), 'btn-remove', () => deleteJobUI(job)))

  header.append(titleWrap, actions)
  section.appendChild(header)

  const statusRow = document.createElement('div')
  statusRow.className = 'job-status-row'

  if (job.lastRun) {
    const badge = document.createElement('span')
    badge.className = `state-badge ${job.lastRun.skipped ? 'state-restarting' : job.lastRun.ok ? 'state-running' : 'state-exited'}`
    badge.textContent = job.lastRun.skipped ? t('tasks.job.lastRunSkipped') : job.lastRun.ok ? t('tasks.job.lastRunSuccess') : t('tasks.job.lastRunFailed')
    const when = document.createElement('span')
    when.className = 'card-sub'
    when.textContent = fmtDateTime(job.lastRun.finishedAt)
    statusRow.append(badge, when)
  } else {
    const never = document.createElement('span')
    never.className = 'card-sub'
    never.textContent = t('tasks.job.never')
    statusRow.appendChild(never)
  }

  if (!job.enabled) {
    const pausedBadge = document.createElement('span')
    pausedBadge.className = 'state-badge state-other'
    pausedBadge.textContent = t('tasks.job.paused')
    statusRow.appendChild(pausedBadge)
  }

  section.appendChild(statusRow)

  if (job.runs && job.runs.length > 0) {
    const historyBox = document.createElement('div')
    historyBox.className = 'job-history hidden'
    job.runs.forEach((run) => historyBox.appendChild(renderJobRun(run)))

    const historyToggle = actionButton(t('tasks.job.viewHistory', { n: job.runs.length }), 'btn-secondary', () => {
      historyBox.classList.toggle('hidden')
    })

    section.appendChild(historyToggle)
    section.appendChild(historyBox)
  }

  return section
}

function renderJobs (jobs) {
  const container = document.getElementById('jobs-container')
  if (jobs.length === 0) {
    container.innerHTML = `<p class="empty-row">${t('tasks.job.none')}</p>`
    return
  }
  container.innerHTML = ''
  jobs.forEach((job) => container.appendChild(renderJob(job)))
}

async function fetchJobs () {
  try {
    const res = await fetch('/api/scheduler/jobs')
    const data = await res.json()
    if (data.ok) renderJobs(data.jobs)
  } catch {
  }
}

export function refreshJobProjectOptions () {
  const select = document.getElementById('job-project')
  if (!select) return
  const current = select.value
  select.innerHTML = composeProjects.map((p) => `<option value="${p}">${p}</option>`).join('')
  if (composeProjects.includes(current)) select.value = current
}

function updateJobFormFields () {
  const type = document.getElementById('job-action-type').value
  document.getElementById('job-project').classList.toggle('hidden', type === 'docker-prune' || type === 'self-backup')
  document.getElementById('job-retention').classList.toggle('hidden', type !== 'backup' && type !== 'self-backup')
}

async function fetchHostSchedule () {
  const container = document.getElementById('host-schedule-container')
  try {
    const res = await fetch('/api/host-schedule')
    const data = await res.json()
    if (!data.ok || !data.available) {
      container.innerHTML = `<p class="empty-row">${data.reason || t('tasks.hostSchedule.unavailable')}</p>`
      return
    }
    renderHostSchedule(data, container)
  } catch (err) {
    container.innerHTML = `<p class="empty-row">${t('common.loadFailed', { error: err.message })}</p>`
  }
}

function renderHostSchedule (data, container) {
  container.innerHTML = ''

  const cronTitle = document.createElement('h4')
  cronTitle.className = 'card-sub'
  cronTitle.textContent = t('tasks.hostSchedule.crontabTitle', { n: data.crontab.length })
  container.appendChild(cronTitle)

  if (data.crontab.length === 0) {
    container.appendChild(Object.assign(document.createElement('p'), { className: 'empty-row', textContent: t('tasks.hostSchedule.noEntries') }))
  } else {
    const scroll = document.createElement('div')
    scroll.className = 'table-scroll'
    const table = document.createElement('table')
    table.className = 'data-table'
    table.innerHTML = `<thead><tr><th>${t('tasks.hostSchedule.schedule')}</th><th>${t('tasks.hostSchedule.command')}</th></tr></thead><tbody></tbody>`
    const tbody = table.querySelector('tbody')
    data.crontab.forEach((entry) => {
      const row = document.createElement('tr')
      row.innerHTML = `<td class="font-mono text-[12px]">${entry.schedule}</td><td class="font-mono text-[12px]">${entry.command}</td>`
      tbody.appendChild(row)
    })
    scroll.appendChild(table)
    container.appendChild(scroll)
  }

  const timerTitle = document.createElement('h4')
  timerTitle.className = 'card-sub mt-3'
  timerTitle.textContent = t('tasks.hostSchedule.timersTitle', { n: data.systemdTimers.length })
  container.appendChild(timerTitle)

  if (data.systemdTimers.length === 0) {
    container.appendChild(Object.assign(document.createElement('p'), { className: 'empty-row', textContent: t('tasks.hostSchedule.noTimers') }))
  } else {
    const scroll = document.createElement('div')
    scroll.className = 'table-scroll'
    const table = document.createElement('table')
    table.className = 'data-table'
    table.innerHTML = `<thead><tr><th>${t('tasks.hostSchedule.unit')}</th><th>${t('tasks.hostSchedule.active')}</th><th>${t('tasks.hostSchedule.nextLast')}</th></tr></thead><tbody></tbody>`
    const tbody = table.querySelector('tbody')
    data.systemdTimers.forEach((timer) => {
      const row = document.createElement('tr')
      row.innerHTML = `<td>${timer.unit}</td><td>${timer.activates}</td><td>${timer.schedule}</td>`
      tbody.appendChild(row)
    })
    scroll.appendChild(table)
    container.appendChild(scroll)
  }

  if (data.stale) {
    const stale = document.createElement('p')
    stale.className = 'card-sub'
    stale.textContent = t('common.staleHostData')
    container.appendChild(stale)
  }
}

function init () {
  refreshJobProjectOptions()

  document.getElementById('job-action-type').addEventListener('change', updateJobFormFields)
  updateJobFormFields()

  document.querySelectorAll('#job-form [data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('job-schedule').value = btn.dataset.preset
    })
  })

  document.getElementById('job-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const errorBox = document.getElementById('job-form-error')
    errorBox.classList.add('hidden')

    const name = document.getElementById('job-name').value.trim()
    const schedule = document.getElementById('job-schedule').value.trim()
    const type = document.getElementById('job-action-type').value

    const action = { type }
    if (type === 'compose-update' || type === 'backup') {
      action.project = document.getElementById('job-project').value
    }
    if (type === 'backup' || type === 'self-backup') {
      const retention = document.getElementById('job-retention').value.trim()
      if (retention) action.retentionDays = Number(retention)
    }

    try {
      const res = await fetch('/api/scheduler/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, schedule, action })
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      showActionResult(true, t('tasks.job.created', { name }))
      event.target.reset()
      updateJobFormFields()
      fetchJobs()
    } catch (err) {
      errorBox.textContent = err.message
      errorBox.classList.remove('hidden')
    }
  })

  fetchJobs()
  setInterval(fetchJobs, JOBS_POLL_INTERVAL_MS)

  fetchHostSchedule()
  setInterval(fetchHostSchedule, 5 * 60 * 1000)

  window.addEventListener('pd-lang-changed', () => {
    fetchJobs()
    fetchHostSchedule()
  })
}

defineView('pd-view-tasks', TEMPLATE_URL, init)
