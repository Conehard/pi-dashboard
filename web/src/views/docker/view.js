import { stateClass, actionButton, setConnectionState, showActionResult, defineView } from '../../core/dom.js'
import { fmtNumber, fmtBytes, fmtDateTime } from '../../core/format.js'
import { t } from '../../core/i18n.js'
import { refreshJobProjectOptions } from '../tasks/view.js'

const TEMPLATE_URL = new URL('./template.html', import.meta.url)

const LIST_POLL_INTERVAL_MS = 5000
const SELF_MANAGED = new Set(['pi-dashboard-api', 'pi-dashboard-web'])
const NO_PROJECT_KEY = '__no_project__'

let dockerEls = null

let currentLogSource = null
let currentInspectedId = null
export let composeProjects = []

async function callAction (id, action, confirmMessage) {
  if (confirmMessage && !window.confirm(confirmMessage)) return

  try {
    const res = await fetch(`/api/docker/containers/${id}/${action}`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    showActionResult(true, t('docker.actions.resultOk', { name: data.name, action }))
  } catch (err) {
    showActionResult(false, t('docker.actions.resultFailed', { action, error: err.message }))
  } finally {
    fetchContainers()
  }
}

async function callProjectAction (project, action, confirmMessage) {
  if (confirmMessage && !window.confirm(confirmMessage)) return

  try {
    const res = await fetch(`/api/docker/projects/${encodeURIComponent(project)}/${action}`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    const failed = (data.results || []).filter(r => !r.ok)
    if (failed.length === 0) {
      showActionResult(true, t('docker.project.resultOk', { project, action, count: data.results.length }))
    } else {
      const names = failed.map(r => `${r.name} (${r.error})`).join(', ')
      showActionResult(false, t('docker.project.resultFailedList', { project, action, names }))
    }
  } catch (err) {
    showActionResult(false, t('docker.project.resultFailed', { action, project, error: err.message }))
  } finally {
    fetchContainers()
  }
}

async function fetchRegistry () {
  try {
    const res = await fetch('/api/compose/registry')
    const data = await res.json()
    if (data.ok) renderRegistry(data)
  } catch {
  }
}

function renderRegistry (data) {
  const banner = document.getElementById('registry-restart-banner')
  banner.classList.toggle('hidden', !data.restartNeeded)

  const list = document.getElementById('registry-pending-list')
  const items = [
    ...data.pendingAdd.map(p => ({ name: p.name, dir: p.dir, kind: 'add' })),
    ...data.pendingRemove.map(name => ({ name, dir: null, kind: 'remove' }))
  ]

  if (items.length === 0) {
    list.classList.add('hidden')
    list.innerHTML = ''
    return
  }

  list.classList.remove('hidden')
  list.innerHTML = ''
  items.forEach((item) => {
    const row = document.createElement('div')
    row.className = 'registry-pending-item'

    const badge = document.createElement('span')
    badge.className = `pending-badge ${item.kind}`
    badge.textContent = item.kind === 'add' ? t('docker.registry.new') : t('docker.registry.removing')
    row.appendChild(badge)

    const name = document.createElement('span')
    name.textContent = item.name
    row.appendChild(name)

    if (item.dir) {
      const pathEl = document.createElement('span')
      pathEl.className = 'pending-path'
      pathEl.textContent = item.dir
      row.appendChild(pathEl)
    }

    if (item.kind === 'add') {
      row.appendChild(actionButton(t('common.cancel'), 'btn-secondary', () => unregisterProjectUI(item.name)))
    }

    list.appendChild(row)
  })
}

async function unregisterProjectUI (name) {
  try {
    const res = await fetch(`/api/compose/registry/${encodeURIComponent(name)}/unregister`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    showActionResult(true, t('docker.registry.unregisterOk', { name }))
  } catch (err) {
    showActionResult(false, t('docker.registry.unregisterFailed', { name, error: err.message }))
  } finally {
    fetchRegistry()
  }
}

export async function fetchComposeProjects () {
  try {
    const res = await fetch('/api/compose/projects')
    const data = await res.json()
    if (data.ok) composeProjects = data.projects
  } catch {
  }
  refreshJobProjectOptions()
}

function domId (projectKey) {
  return projectKey.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function appendComposeOutput (outputEl, line) {
  outputEl.parentElement.classList.remove('hidden')
  outputEl.textContent += line + '\n'
  outputEl.scrollTop = outputEl.scrollHeight
}

function runComposeStream (project, action, outputEl, confirmMessage) {
  if (confirmMessage && !window.confirm(confirmMessage)) return

  outputEl.textContent = ''
  outputEl.parentElement.classList.remove('hidden')
  appendComposeOutput(outputEl, `$ docker compose ${action === 'up' ? 'up -d --remove-orphans' : action}`)

  const source = new EventSource(`/api/compose/projects/${encodeURIComponent(project)}/run/${action}`)

  source.onmessage = (event) => {
    let line
    try {
      line = JSON.parse(event.data)
    } catch {
      line = event.data
    }
    appendComposeOutput(outputEl, line)
  }

  source.addEventListener('error', (event) => {
    if (event.data) {
      try {
        appendComposeOutput(outputEl, t('docker.compose.errorPrefix', { msg: JSON.parse(event.data) }))
      } catch {
        appendComposeOutput(outputEl, t('docker.compose.errorConn'))
      }
    }
    source.close()
    fetchContainers()
  })

  source.addEventListener('done', (event) => {
    const data = JSON.parse(event.data)
    appendComposeOutput(outputEl, t('docker.compose.done', { code: data.exitCode }))
    source.close()
    fetchContainers()
  })
}

async function openComposeEditor (project, editorBox) {
  const textarea = editorBox.querySelector('.compose-editor-textarea')
  const errorBox = editorBox.querySelector('.compose-editor-error')
  const saveBtn = editorBox.querySelector('.compose-editor-save')

  editorBox.classList.remove('hidden')
  errorBox.classList.add('hidden')
  textarea.value = t('common.loading')
  textarea.disabled = true

  try {
    const res = await fetch(`/api/compose/projects/${encodeURIComponent(project)}/file`)
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    textarea.value = data.content
  } catch (err) {
    textarea.value = ''
    errorBox.textContent = t('common.loadFailed', { error: err.message })
    errorBox.classList.remove('hidden')
  } finally {
    textarea.disabled = false
  }

  saveBtn.onclick = async () => {
    errorBox.classList.add('hidden')
    saveBtn.disabled = true
    saveBtn.textContent = t('docker.compose.saving')
    try {
      const res = await fetch(`/api/compose/projects/${encodeURIComponent(project)}/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: textarea.value })
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      showActionResult(true, t('docker.compose.savedOk', { project }))
      editorBox.classList.add('hidden')
    } catch (err) {
      errorBox.textContent = err.message
      errorBox.classList.remove('hidden')
    } finally {
      saveBtn.disabled = false
      saveBtn.textContent = t('common.save')
    }
  }
}

function closeLogStream () {
  if (currentLogSource) {
    currentLogSource.close()
    currentLogSource = null
  }
}

function setActiveTab (tab) {
  dockerEls.tabButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab))
  dockerEls.tabLogs.classList.toggle('hidden', tab !== 'logs')
  dockerEls.tabDetails.classList.toggle('hidden', tab !== 'details')
}

function openInspector (id, name, tab) {
  currentInspectedId = id
  dockerEls.inspectorName.textContent = name
  dockerEls.inspectorPanel.classList.remove('hidden')
  dockerEls.inspectorPanel.scrollIntoView({ behavior: 'smooth', block: 'start' })
  setActiveTab(tab)
}

function openLogs (id, name) {
  closeLogStream()
  dockerEls.logsView.textContent = ''
  openInspector(id, name, 'logs')

  const source = new EventSource(`/api/docker/containers/${id}/logs?tail=200`)
  currentLogSource = source

  source.onmessage = (event) => {
    let line
    try {
      line = JSON.parse(event.data)
    } catch {
      line = event.data
    }
    dockerEls.logsView.textContent += line + '\n'
    if (dockerEls.logsAutoscroll.checked) {
      dockerEls.logsView.scrollTop = dockerEls.logsView.scrollHeight
    }
  }

  source.addEventListener('error', () => {
    dockerEls.logsView.textContent += t('docker.inspector.connLost') + '\n'
  })
}

function fmtPorts (ports) {
  const entries = Object.entries(ports || {})
  if (entries.length === 0) return '--'
  return entries.map(([containerPort, bindings]) => {
    if (!bindings || bindings.length === 0) return containerPort
    return bindings.map(b => `${b.HostIp || '0.0.0.0'}:${b.HostPort} → ${containerPort}`).join(', ')
  }).join('; ')
}

function fmtMounts (mounts) {
  if (!mounts || mounts.length === 0) return '--'
  return mounts.map(m => `${m.source} → ${m.destination} (${m.rw ? 'rw' : 'ro'})`).join('\n')
}

function envRow (envEntry) {
  const idx = envEntry.indexOf('=')
  const key = idx >= 0 ? envEntry.slice(0, idx) : envEntry
  const value = idx >= 0 ? envEntry.slice(idx + 1) : ''

  const wrapper = document.createElement('div')
  const keySpan = document.createElement('span')
  keySpan.textContent = `${key}=`
  const valueSpan = document.createElement('span')
  valueSpan.className = 'env-value masked'
  valueSpan.textContent = '••••••••'
  valueSpan.title = t('docker.details.revealHint')
  valueSpan.addEventListener('click', () => {
    const masked = valueSpan.classList.toggle('masked')
    valueSpan.textContent = masked ? '••••••••' : value
  })
  wrapper.appendChild(keySpan)
  wrapper.appendChild(valueSpan)
  return wrapper
}

async function openDetails (id, name) {
  openInspector(id, name, 'details')
  dockerEls.detailsBody.innerHTML = `<div class="empty-row">${t('common.loading')}</div>`

  try {
    const res = await fetch(`/api/docker/containers/${id}/details`)
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)

    const d = data.details
    dockerEls.detailsBody.innerHTML = ''

    const addRow = (label, valueNode) => {
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      if (typeof valueNode === 'string') {
        dd.textContent = valueNode
      } else {
        dd.appendChild(valueNode)
      }
      dockerEls.detailsBody.appendChild(dt)
      dockerEls.detailsBody.appendChild(dd)
    }

    addRow(t('docker.details.id'), d.id)
    addRow(t('common.image'), d.image)
    addRow(t('docker.details.command'), d.command || '--')
    addRow(t('common.createdAt'), fmtDateTime(d.created))
    addRow(t('docker.details.restartPolicy'), (d.restartPolicy && d.restartPolicy.Name) || '--')
    addRow(t('docker.details.composeProject'), d.composeProject ? `${d.composeProject} / ${d.composeService || '--'}` : t('docker.details.noProject'))
    addRow(t('docker.details.networks'), (d.networks || []).join(', ') || '--')
    addRow(t('docker.details.ports'), fmtPorts(d.ports))
    addRow(t('docker.details.mounts'), fmtMounts(d.mounts))

    if (d.env && d.env.length > 0) {
      const envList = document.createElement('div')
      d.env.forEach(entry => envList.appendChild(envRow(entry)))
      addRow(t('docker.details.env'), envList)
    } else {
      addRow(t('docker.details.env'), '--')
    }
  } catch (err) {
    dockerEls.detailsBody.innerHTML = `<div class="empty-row">${t('docker.details.loadFailed', { error: err.message })}</div>`
  }
}

function renderActions (c) {
  const cell = document.createElement('td')
  cell.className = 'actions-cell'

  const state = (c.state || '').toLowerCase()
  const selfManaged = SELF_MANAGED.has(c.name)

  if (selfManaged) {
    const note = document.createElement('span')
    note.className = 'card-sub'
    note.textContent = t('docker.actions.selfManaged')
    cell.appendChild(note)
    cell.appendChild(actionButton(t('common.logs'), 'btn-logs', () => openLogs(c.id, c.name)))
    cell.appendChild(actionButton(t('common.details'), 'btn-details', () => openDetails(c.id, c.name)))
    return cell
  }

  if (state === 'running') {
    cell.appendChild(actionButton('Stop', 'btn-stop', () =>
      callAction(c.id, 'stop', t('docker.actions.confirmStop', { name: c.name }))))
    cell.appendChild(actionButton('Pause', 'btn-pause', () => callAction(c.id, 'pause')))
    cell.appendChild(actionButton('Restart', 'btn-restart', () =>
      callAction(c.id, 'restart', t('docker.actions.confirmRestart', { name: c.name }))))
  } else if (state === 'paused') {
    cell.appendChild(actionButton('Unpause', 'btn-start', () => callAction(c.id, 'unpause')))
  } else {
    cell.appendChild(actionButton('Start', 'btn-start', () => callAction(c.id, 'start')))
    cell.appendChild(actionButton('Remove', 'btn-remove', () =>
      callAction(c.id, 'remove', t('docker.actions.confirmRemove', { name: c.name }))))
  }

  if (state !== 'paused') {
    cell.appendChild(actionButton('Recreate', 'btn-recreate', () =>
      callAction(c.id, 'recreate', t('docker.actions.confirmRecreate', { name: c.name }))))
  }

  cell.appendChild(actionButton(t('common.logs'), 'btn-logs', () => openLogs(c.id, c.name)))
  cell.appendChild(actionButton(t('common.details'), 'btn-details', () => openDetails(c.id, c.name)))

  return cell
}

function groupByProject (containers) {
  const groups = new Map()
  composeProjects.forEach((name) => groups.set(name, []))
  containers.forEach((c) => {
    const key = c.composeProject || NO_PROJECT_KEY
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  })
  return groups
}

function renderProjectHeader (projectKey, containers) {
  const header = document.createElement('div')
  header.className = 'project-header'

  const h3 = document.createElement('h3')
  h3.textContent = projectKey === NO_PROJECT_KEY ? t('docker.noProject.compose') : projectKey
  header.appendChild(h3)

  const allSelfManaged = containers.every(c => SELF_MANAGED.has(c.name))
  if (projectKey !== NO_PROJECT_KEY && !allSelfManaged) {
    const actions = document.createElement('div')
    actions.className = 'project-actions'
    actions.appendChild(actionButton(t('docker.project.startBtn'), 'btn-start', () =>
      callProjectAction(projectKey, 'start')))
    actions.appendChild(actionButton(t('docker.project.stopBtn'), 'btn-stop', () =>
      callProjectAction(projectKey, 'stop', t('docker.project.confirmStop', { project: projectKey }))))
    actions.appendChild(actionButton(t('docker.project.restartBtn'), 'btn-restart', () =>
      callProjectAction(projectKey, 'restart', t('docker.project.confirmRestart', { project: projectKey }))))
    header.appendChild(actions)
  }

  return header
}

function renderComposeControls (projectKey) {
  const wrapper = document.createElement('div')
  const id = domId(projectKey)

  const toolbar = document.createElement('div')
  toolbar.className = 'compose-toolbar'
  const pullBtn = actionButton('Pull', 'btn-details', () => runComposeStream(projectKey, 'pull', outputPre))
  const upBtn = actionButton(t('docker.compose.up'), 'btn-start', () => runComposeStream(projectKey, 'up', outputPre))
  const downBtn = actionButton('Down', 'btn-remove', () =>
    runComposeStream(projectKey, 'down', outputPre, t('docker.compose.confirmDown', { project: projectKey })))
  const backupBtn = actionButton(t('docker.compose.backupNow'), 'btn-details', () => runBackupNow(projectKey, backupsBox))
  const viewBackupsBtn = actionButton(t('docker.compose.viewBackups'), 'btn-secondary', () => toggleBackupsList(projectKey, backupsBox))
  const editBtn = actionButton(t('docker.compose.editYml'), 'btn-details', () => openComposeEditor(projectKey, editorBox))
  const unregisterBtn = actionButton(t('docker.compose.removeProject'), 'btn-remove', () => {
    if (!window.confirm(t('docker.registry.unregisterConfirm', { project: projectKey }))) return
    unregisterProjectUI(projectKey)
  })
  toolbar.append(pullBtn, upBtn, downBtn, backupBtn, viewBackupsBtn, editBtn, unregisterBtn)

  const backupsBox = document.createElement('div')
  backupsBox.className = 'backups-list hidden'

  const outputWrap = document.createElement('div')
  outputWrap.className = 'compose-output hidden'
  const outputPre = document.createElement('pre')
  outputPre.className = 'logs-view'
  const closeOutputBtn = actionButton(t('docker.compose.closeOutput'), 'btn-secondary', () => outputWrap.classList.add('hidden'))
  outputWrap.append(outputPre, closeOutputBtn)

  const editorBox = document.createElement('div')
  editorBox.className = 'compose-editor hidden'
  editorBox.id = `compose-editor-${id}`
  editorBox.innerHTML = `
    <p class="compose-editor-warning">${t('docker.compose.editorWarning')}</p>
    <textarea class="compose-editor-textarea" spellcheck="false"></textarea>
    <div class="compose-editor-error hidden banner-error"></div>
    <div class="compose-editor-actions">
      <button type="button" class="btn btn-start compose-editor-save">${t('common.save')}</button>
      <button type="button" class="btn btn-secondary compose-editor-cancel">${t('docker.compose.cancel')}</button>
    </div>
  `
  editorBox.querySelector('.compose-editor-cancel').addEventListener('click', () => editorBox.classList.add('hidden'))

  wrapper.append(toolbar, outputWrap, editorBox, backupsBox)
  return wrapper
}

export async function runBackupNow (project, backupsBox) {
  try {
    const res = await fetch(`/api/backups/${encodeURIComponent(project)}`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    if (data.skipped) {
      showActionResult(false, data.reason)
    } else {
      showActionResult(true, t('docker.backups.createdOk', { project, size: fmtBytes(data.sizeBytes) }))
      if (!backupsBox.classList.contains('hidden')) await loadBackupsList(project, backupsBox)
    }
  } catch (err) {
    showActionResult(false, t('docker.backups.createFailed', { project, error: err.message }))
  }
}

export async function toggleBackupsList (project, backupsBox) {
  if (backupsBox.classList.contains('hidden')) {
    await loadBackupsList(project, backupsBox)
    backupsBox.classList.remove('hidden')
  } else {
    backupsBox.classList.add('hidden')
  }
}

async function loadBackupsList (project, backupsBox) {
  backupsBox.innerHTML = `<p class="empty-row">${t('common.loading')}</p>`
  try {
    const res = await fetch(`/api/backups/${encodeURIComponent(project)}`)
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    renderBackupsList(project, data.backups, backupsBox)
  } catch (err) {
    backupsBox.innerHTML = `<p class="empty-row">${t('docker.backups.loadFailed', { error: err.message })}</p>`
  }
}

function renderBackupsList (project, backups, backupsBox) {
  if (backups.length === 0) {
    backupsBox.innerHTML = `<p class="empty-row">${t('docker.backups.none')}</p>`
    return
  }

  const table = document.createElement('table')
  table.className = 'data-table'
  table.innerHTML = `
    <thead><tr><th>${t('docker.backups.file')}</th><th>${t('docker.backups.size')}</th><th>${t('common.createdAt')}</th><th>${t('common.actions')}</th></tr></thead>
    <tbody></tbody>
  `
  const tbody = table.querySelector('tbody')

  backups.forEach((b) => {
    const row = document.createElement('tr')
    row.innerHTML = `
      <td>${b.name}</td>
      <td>${fmtBytes(b.sizeBytes)}</td>
      <td>${fmtDateTime(b.createdAt)}</td>
    `

    const actionsCell = document.createElement('td')
    actionsCell.className = 'actions-cell'

    const downloadLink = document.createElement('a')
    downloadLink.href = `/api/backups/${encodeURIComponent(project)}/${encodeURIComponent(b.name)}`
    downloadLink.className = 'btn-link'
    downloadLink.textContent = t('docker.backups.download')
    downloadLink.setAttribute('download', b.name)

    const delBtn = actionButton(t('docker.backups.delete'), 'btn-remove', async () => {
      if (!window.confirm(t('docker.backups.confirmDelete', { name: b.name }))) return
      try {
        const res = await fetch(`/api/backups/${encodeURIComponent(project)}/${encodeURIComponent(b.name)}`, { method: 'DELETE' })
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
        loadBackupsList(project, backupsBox)
      } catch (err) {
        showActionResult(false, t('docker.backups.deleteFailed', { error: err.message }))
      }
    })

    actionsCell.append(downloadLink, delBtn)
    row.appendChild(actionsCell)
    tbody.appendChild(row)
  })

  backupsBox.innerHTML = ''
  backupsBox.appendChild(table)
}

function renderProjectTable (containers, imageUpdates = {}) {
  const scroll = document.createElement('div')
  scroll.className = 'table-scroll'

  const table = document.createElement('table')
  table.className = 'data-table'
  table.innerHTML = `
    <thead>
      <tr>
        <th>${t('common.name')}</th>
        <th>${t('common.image')}</th>
        <th>${t('common.state')}</th>
        <th>Status</th>
        <th>${t('common.cpu')}</th>
        <th>${t('common.memory')}</th>
        <th>${t('common.actions')}</th>
      </tr>
    </thead>
    <tbody></tbody>
  `

  const tbody = table.querySelector('tbody')

  if (containers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">${t('docker.noContainersInProject')}</td></tr>`
  }

  containers.forEach((c) => {
    const update = imageUpdates[c.image]
    const updateBadge = update && update.updateAvailable
      ? ` <span class="state-badge state-restarting" title="${t('docker.table.checkedAt', { when: fmtDateTime(update.checkedAt) })}">${t('docker.table.updateAvailable')}</span>`
      : ''
    const row = document.createElement('tr')
    row.innerHTML = `
      <td>${c.name}</td>
      <td>${c.image}${updateBadge}</td>
      <td><span class="state-badge ${stateClass(c.state)}">${c.state}</span></td>
      <td>${c.status || '--'}</td>
      <td>${fmtNumber(c.cpuPercent, 1, '%')}</td>
      <td>${fmtBytes(c.memUsageBytes)}</td>
    `
    row.appendChild(renderActions(c))
    tbody.appendChild(row)
  })

  scroll.appendChild(table)
  return scroll
}

function renderNav (groups) {
  dockerEls.projectNav.innerHTML = ''
  groups.forEach((containers, projectKey) => {
    const link = document.createElement('a')
    link.href = `#project-${projectKey === NO_PROJECT_KEY ? 'none' : projectKey}`
    const label = document.createElement('span')
    label.textContent = projectKey === NO_PROJECT_KEY ? t('docker.noProject.compose') : projectKey
    const count = document.createElement('span')
    count.className = 'nav-count'
    count.textContent = containers.length
    link.appendChild(label)
    link.appendChild(count)
    dockerEls.projectNav.appendChild(link)
  })
}

function renderProjects (docker) {
  if (!docker || !docker.available) {
    dockerEls.dockerError.textContent = docker && docker.error ? docker.error : t('overview.docker.unavailable')
    dockerEls.dockerError.classList.remove('hidden')
    dockerEls.projectsContainer.innerHTML = ''
    dockerEls.projectNav.innerHTML = `<span class="empty-row">${t('common.noData')}</span>`
    return
  }

  dockerEls.dockerError.classList.add('hidden')

  if (docker.containers.length === 0 && composeProjects.length === 0) {
    dockerEls.projectsContainer.innerHTML = `<p class="empty-row">${t('docker.noContainersFound')}</p>`
    dockerEls.projectNav.innerHTML = `<span class="empty-row">${t('docker.noProject.short')}</span>`
    return
  }

  const groups = groupByProject(docker.containers)
  renderNav(groups)

  const seenIds = new Set()
  groups.forEach((containers, projectKey) => {
    const sectionId = `project-${projectKey === NO_PROJECT_KEY ? 'none' : projectKey}`
    seenIds.add(sectionId)

    const existing = document.getElementById(sectionId)
    if (existing) {
      const busy = existing.querySelector('.compose-editor:not(.hidden), .compose-output:not(.hidden), .backups-list:not(.hidden)')
      if (busy) return
      existing.remove()
    }

    const section = document.createElement('section')
    section.className = 'panel'
    section.id = sectionId
    section.appendChild(renderProjectHeader(projectKey, containers))
    if (projectKey !== NO_PROJECT_KEY && composeProjects.includes(projectKey)) {
      section.appendChild(renderComposeControls(projectKey))
    }
    section.appendChild(renderProjectTable(containers, docker.imageUpdates))
    dockerEls.projectsContainer.appendChild(section)
  })

  Array.from(dockerEls.projectsContainer.children).forEach((el) => {
    if (!seenIds.has(el.id)) el.remove()
  })
}

async function fetchContainers () {
  try {
    const res = await fetch('/api/docker/containers', { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    setConnectionState('ok')
    renderProjects(data)
  } catch (err) {
    setConnectionState('error')
  }
}

function init () {
  dockerEls = {
    dockerError: document.getElementById('docker-error'),
    projectNav: document.getElementById('project-nav'),
    projectsContainer: document.getElementById('projects-container'),

    inspectorPanel: document.getElementById('inspector-panel'),
    inspectorName: document.getElementById('inspector-name'),
    inspectorClose: document.getElementById('inspector-close'),
    tabButtons: document.querySelectorAll('#inspector-panel .tab-btn'),
    tabLogs: document.getElementById('tab-logs'),
    tabDetails: document.getElementById('tab-details'),

    logsView: document.getElementById('logs-view'),
    logsAutoscroll: document.getElementById('logs-autoscroll'),
    detailsBody: document.getElementById('details-body')
  }

  document.getElementById('prune-btn').addEventListener('click', async () => {
    if (!window.confirm(t('docker.maintenance.confirmPrune'))) return

    const btn = document.getElementById('prune-btn')
    btn.disabled = true
    btn.textContent = t('docker.maintenance.pruning')
    try {
      const res = await fetch('/api/docker/prune', { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      showActionResult(true, t('docker.maintenance.pruneResult', { count: data.imagesDeleted, size: fmtBytes(data.spaceReclaimedBytes) }))
    } catch (err) {
      showActionResult(false, t('docker.maintenance.pruneFailed', { error: err.message }))
    } finally {
      btn.disabled = false
      btn.textContent = t('docker.maintenance.pruneBtn')
    }
  })

  document.getElementById('registry-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const nameInput = document.getElementById('registry-name')
    const pathInput = document.getElementById('registry-path')
    const errorBox = document.getElementById('registry-error')
    errorBox.classList.add('hidden')

    const name = nameInput.value.trim()
    const hostPath = pathInput.value.trim()

    try {
      const res = await fetch('/api/compose/registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path: hostPath })
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      showActionResult(true, t('docker.registry.registerOk', { name }))
      nameInput.value = ''
      pathInput.value = ''
      fetchRegistry()
    } catch (err) {
      errorBox.textContent = err.message
      errorBox.classList.remove('hidden')
    }
  })

  dockerEls.tabButtons.forEach(btn => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab))
  })

  dockerEls.inspectorClose.addEventListener('click', () => {
    closeLogStream()
    currentInspectedId = null
    dockerEls.inspectorPanel.classList.add('hidden')
  })

  fetchComposeProjects().then(fetchContainers)
  fetchRegistry()
  setInterval(fetchContainers, LIST_POLL_INTERVAL_MS)
  setInterval(fetchComposeProjects, 30000)
  setInterval(fetchRegistry, 30000)

  window.addEventListener('pd-lang-changed', () => {
    fetchContainers()
    fetchRegistry()
  })
}

defineView('pd-view-docker', TEMPLATE_URL, init)
