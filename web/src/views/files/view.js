// File manager screen (#files) - browse the internal storage and any connected disk, and open/download/
// upload/rename/move/delete files there. Everything is addressed as { root, path } (a disk id + a path
// relative to it), never an absolute host path - see api/src/features/files/files.js.
import { actionButton, defineView, showActionResult } from '../../core/dom.js'
import { openModal } from '../../core/modal.js'
import { fmtBytes, fmtDateTime } from '../../core/format.js'
import { getLanguage, t } from '../../core/i18n.js'

const TEMPLATE_URL = new URL('./template.html', import.meta.url)
const LOCATION_KEY = 'pi-dashboard:filesLocation'
const SHOW_HIDDEN_KEY = 'pi-dashboard:filesShowHidden'

let els = {}
let roots = []
let current = { root: 'internal', path: '' }
let entries = []
let selected = new Set() // entry names in the current folder
let showHidden = false
let uploadQueue = Promise.resolve()

// --- helpers ---

async function apiCall (url, options) {
  const res = await fetch(url, options)
  const data = await res.json().catch(() => null)
  if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data
}

function postJson (url, payload) {
  return apiCall(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

function query (params) {
  return new URLSearchParams(params).toString()
}

function joinPath (dir, name) {
  return dir ? `${dir}/${name}` : name
}

function rootLabel (root) {
  if (!root) return '?'
  return root.kind === 'internal' ? t('files.root.internal') : root.label
}

function downloadUrl (entryPath, { inline } = {}) {
  return `/api/files/download?${query({ root: current.root, path: entryPath, ...(inline ? { inline: '1' } : {}) })}`
}

function saveLocation () {
  try { localStorage.setItem(LOCATION_KEY, JSON.stringify(current)) } catch { }
}

function readSavedLocation () {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCATION_KEY) || 'null')
    if (saved && typeof saved.root === 'string' && typeof saved.path === 'string') return saved
  } catch { }
  return null
}

// --- roots (disk cards) ---

async function loadRoots () {
  try {
    roots = (await apiCall('/api/files/roots')).roots
  } catch (err) {
    els.roots.innerHTML = ''
    const p = document.createElement('p')
    p.className = 'empty-row'
    p.textContent = t('common.loadFailed', { error: err.message })
    els.roots.appendChild(p)
    return
  }
  if (!roots.some((r) => r.id === current.root)) current = { root: roots[0] ? roots[0].id : 'internal', path: '' }
  renderRoots()
}

function renderRoots () {
  els.roots.innerHTML = ''
  roots.forEach((root) => {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = `files-root-card${root.id === current.root ? ' active' : ''}`
    card.addEventListener('click', () => navigate(root.id, ''))

    const title = document.createElement('div')
    title.className = 'files-root-title'
    const name = document.createElement('span')
    name.className = 'files-root-name'
    name.textContent = `${root.kind === 'internal' ? '💾' : '🖴'} ${rootLabel(root)}`
    const badge = document.createElement('span')
    badge.className = `state-badge ${root.kind === 'internal' ? 'state-other' : 'state-running'}`
    badge.textContent = t(root.kind === 'internal' ? 'files.kind.internal' : 'files.kind.external')
    title.append(name, badge)
    card.appendChild(title)

    if (root.totalBytes) {
      const used = root.totalBytes - root.availableBytes
      const pct = (used / root.totalBytes) * 100
      const bar = document.createElement('div')
      bar.className = 'progress-bar files-root-bar'
      const fill = document.createElement('div')
      fill.className = `progress-bar-fill${pct >= 95 ? ' danger' : pct >= 85 ? ' warn' : ''}`
      fill.style.width = `${pct.toFixed(1)}%`
      bar.appendChild(fill)
      const sub = document.createElement('div')
      sub.className = 'card-sub'
      sub.textContent = t('files.freeOf', { free: fmtBytes(root.availableBytes), total: fmtBytes(root.totalBytes) })
      card.append(bar, sub)
    }
    els.roots.appendChild(card)
  })
}

// --- listing ---

function navigate (rootId, dirPath) {
  current = { root: rootId, path: dirPath }
  selected.clear()
  saveLocation()
  renderRoots()
  loadDir()
}

async function loadDir () {
  renderBreadcrumb()
  try {
    const data = await apiCall(`/api/files/list?${query(current)}`)
    entries = data.entries
  } catch (err) {
    // Saved location no longer exists (deleted elsewhere, disk swapped) - fall back to that disk's root
    // once instead of leaving the screen stuck on an error.
    if (current.path) {
      current.path = ''
      saveLocation()
      return loadDir()
    }
    entries = []
    renderTable(t('common.loadFailed', { error: err.message }))
    return
  }
  const names = new Set(entries.map((e) => e.name))
  selected.forEach((n) => { if (!names.has(n)) selected.delete(n) })
  renderTable()
}

function renderBreadcrumb () {
  els.breadcrumb.innerHTML = ''
  const root = roots.find((r) => r.id === current.root)
  const parts = current.path ? current.path.split('/') : []
  const crumbs = [{ label: rootLabel(root), path: '' }]
  parts.forEach((part, i) => crumbs.push({ label: part, path: parts.slice(0, i + 1).join('/') }))

  crumbs.forEach((crumb, i) => {
    if (i > 0) {
      const sep = document.createElement('span')
      sep.className = 'files-crumb-sep'
      sep.textContent = '/'
      els.breadcrumb.appendChild(sep)
    }
    const last = i === crumbs.length - 1
    const el = document.createElement(last ? 'span' : 'button')
    el.className = last ? 'files-crumb current' : 'files-crumb btn-link'
    el.textContent = crumb.label
    if (!last) {
      el.type = 'button'
      el.addEventListener('click', () => navigate(current.root, crumb.path))
    }
    els.breadcrumb.appendChild(el)
  })
}

function visibleEntries () {
  return showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'))
}

function entryIcon (entry) {
  if (entry.type === 'dir') return '📁'
  if (entry.type === 'other') return entry.symlink ? '🔗' : '❔'
  const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) return '🖼'
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v'].includes(ext)) return '🎞'
  if (['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'opus'].includes(ext)) return '🎵'
  if (['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst'].includes(ext)) return '🗜'
  if (ext === 'pdf') return '📕'
  return '📄'
}

function renderTable (message) {
  els.tbody.innerHTML = ''
  const list = visibleEntries()
  if (message || list.length === 0) {
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.colSpan = 5
    td.className = 'empty-row'
    td.textContent = message || t('files.emptyFolder')
    tr.appendChild(td)
    els.tbody.appendChild(tr)
  }

  if (!message && current.path) els.tbody.prepend(parentRow())

  list.forEach((entry) => els.tbody.appendChild(entryRow(entry)))
  renderSelectionBar()
}

function parentRow () {
  const tr = document.createElement('tr')
  tr.className = 'files-row'
  const tdCheck = document.createElement('td')
  const tdName = document.createElement('td')
  tdName.colSpan = 4
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'files-name'
  btn.textContent = '⮤ ..'
  btn.addEventListener('click', () => navigate(current.root, current.path.split('/').slice(0, -1).join('/')))
  tdName.appendChild(btn)
  tr.append(tdCheck, tdName)
  return tr
}

function entryRow (entry) {
  const entryPath = joinPath(current.path, entry.name)
  const tr = document.createElement('tr')
  tr.className = `files-row${selected.has(entry.name) ? ' selected' : ''}`

  const tdCheck = document.createElement('td')
  tdCheck.className = 'files-check-col'
  const check = document.createElement('input')
  check.type = 'checkbox'
  check.checked = selected.has(entry.name)
  check.setAttribute('aria-label', entry.name)
  check.addEventListener('change', () => {
    if (check.checked) selected.add(entry.name)
    else selected.delete(entry.name)
    tr.classList.toggle('selected', check.checked)
    renderSelectionBar()
  })
  tdCheck.appendChild(check)

  const tdName = document.createElement('td')
  const nameBtn = document.createElement('button')
  nameBtn.type = 'button'
  nameBtn.className = 'files-name'
  nameBtn.textContent = `${entryIcon(entry)} ${entry.name}${entry.symlink ? ' ↪' : ''}`
  nameBtn.title = entry.name
  nameBtn.addEventListener('click', () => openEntry(entry))
  tdName.appendChild(nameBtn)

  const tdSize = document.createElement('td')
  tdSize.className = 'files-dim'
  tdSize.textContent = entry.type === 'file' ? fmtBytes(entry.sizeBytes) : '--'

  const tdModified = document.createElement('td')
  tdModified.className = 'files-dim'
  tdModified.textContent = fmtDateTime(entry.modifiedAt)

  const tdActions = document.createElement('td')
  const actions = document.createElement('div')
  actions.className = 'actions-cell'
  if (entry.type === 'file') {
    actions.appendChild(actionButton(t('files.downloadBtn'), 'btn-logs', () => triggerDownload(entryPath)))
  }
  actions.append(
    actionButton(t('files.renameBtn'), 'btn-details', () => renameUI(entry)),
    actionButton(t('files.moveBtn'), 'btn-pause', () => moveUI([entry.name])),
    actionButton(t('files.deleteBtn'), 'btn-remove', () => deleteUI([entry.name]))
  )
  tdActions.appendChild(actions)

  tr.append(tdCheck, tdName, tdSize, tdModified, tdActions)
  return tr
}

function renderSelectionBar () {
  const visibleNames = new Set(visibleEntries().map((e) => e.name))
  const count = [...selected].filter((n) => visibleNames.has(n)).length
  els.selectionBar.classList.toggle('hidden', count === 0)
  els.selectionCount.textContent = t('files.selectedCount', { count })
  els.selectAll.checked = count > 0 && count === visibleNames.size
  els.selectAll.indeterminate = count > 0 && count < visibleNames.size
}

function selectedVisibleNames () {
  const visibleNames = new Set(visibleEntries().map((e) => e.name))
  return [...selected].filter((n) => visibleNames.has(n))
}

// --- actions ---

function openEntry (entry) {
  const entryPath = joinPath(current.path, entry.name)
  if (entry.type === 'dir') {
    navigate(current.root, entryPath)
    return
  }
  if (entry.type !== 'file') return
  if (entry.open) window.open(downloadUrl(entryPath, { inline: true }), '_blank', 'noopener')
  else triggerDownload(entryPath)
}

function triggerDownload (entryPath) {
  const a = document.createElement('a')
  a.href = downloadUrl(entryPath)
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

async function mkdirUI () {
  const name = prompt(t('files.newFolderPrompt'))
  if (!name || !name.trim()) return
  try {
    await postJson('/api/files/mkdir', { ...current, name: name.trim() })
    loadDir()
  } catch (err) {
    showActionResult(false, err.message)
  }
}

async function renameUI (entry) {
  const newName = prompt(t('files.renamePrompt'), entry.name)
  if (!newName || !newName.trim() || newName.trim() === entry.name) return
  try {
    await postJson('/api/files/rename', { root: current.root, path: joinPath(current.path, entry.name), newName: newName.trim() })
    selected.delete(entry.name)
    loadDir()
  } catch (err) {
    showActionResult(false, err.message)
  }
}

async function deleteUI (names) {
  if (names.length === 0) return
  const hasDir = names.some((n) => (entries.find((e) => e.name === n) || {}).type === 'dir')
  const message = names.length === 1
    ? t(hasDir ? 'files.confirmDeleteDir' : 'files.confirmDeleteOne', { name: names[0] })
    : t('files.confirmDeleteMany', { count: names.length })
  if (!window.confirm(message)) return
  try {
    await postJson('/api/files/delete', { items: names.map((n) => ({ root: current.root, path: joinPath(current.path, n) })) })
    names.forEach((n) => selected.delete(n))
    showActionResult(true, t('files.deleted', { count: names.length }))
  } catch (err) {
    showActionResult(false, err.message)
  }
  loadDir()
  loadRoots()
}

// Folder picker modal for "move" - its own little browser (disk select + folders only), independent
// of the main listing's current location, so the user can move things to any disk/folder.
function moveUI (names) {
  if (names.length === 0) return
  const source = { ...current }
  let target = { ...current }

  openModal({
    title: names.length === 1 ? t('files.moveTitleOne', { name: names[0] }) : t('files.moveTitleMany', { count: names.length }),
    body: (dialog) => {
      const wrap = document.createElement('div')
      wrap.className = 'files-picker'

      const rootSelect = document.createElement('select')
      rootSelect.className = 'history-range-select'
      roots.forEach((r) => {
        const opt = document.createElement('option')
        opt.value = r.id
        opt.textContent = rootLabel(r)
        rootSelect.appendChild(opt)
      })
      rootSelect.value = target.root

      const pathLine = document.createElement('div')
      pathLine.className = 'files-picker-path'
      const list = document.createElement('div')
      list.className = 'files-picker-list'
      const error = document.createElement('div')
      error.className = 'banner-error hidden'

      const footer = document.createElement('div')
      footer.className = 'files-picker-footer'
      const confirmBtn = actionButton(t('files.moveHereBtn'), 'btn-start', async () => {
        confirmBtn.disabled = true
        try {
          const result = await postJson('/api/files/move', {
            items: names.map((n) => ({ root: source.root, path: joinPath(source.path, n) })),
            destRoot: target.root,
            destPath: target.path
          })
          names.forEach((n) => selected.delete(n))
          dialog.close()
          showActionResult(true, t('files.moved', { count: result.moved }))
        } catch (err) {
          error.textContent = err.message
          error.classList.remove('hidden')
          confirmBtn.disabled = false
        }
        loadDir()
        loadRoots()
      })
      footer.append(actionButton(t('common.cancel'), 'btn-details', () => dialog.close()), confirmBtn)

      async function showFolder (rootId, dirPath) {
        target = { root: rootId, path: dirPath }
        const root = roots.find((r) => r.id === rootId)
        pathLine.textContent = `${rootLabel(root)} / ${dirPath}`
        confirmBtn.disabled = target.root === source.root && target.path === source.path
        list.innerHTML = ''
        let dirs
        try {
          dirs = (await apiCall(`/api/files/list?${query(target)}`)).entries.filter((e) => e.type === 'dir' && (showHidden || !e.name.startsWith('.')))
        } catch (err) {
          list.textContent = t('common.loadFailed', { error: err.message })
          return
        }
        if (dirPath) {
          list.appendChild(pickerItem('⮤ ..', () => showFolder(rootId, dirPath.split('/').slice(0, -1).join('/'))))
        }
        dirs.forEach((d) => {
          const childPath = joinPath(dirPath, d.name)
          // Moving a folder into itself/its own subfolder is refused server-side anyway - just don't offer it.
          const isMoving = rootId === source.root && names.some((n) => joinPath(source.path, n) === childPath)
          if (!isMoving) list.appendChild(pickerItem(`📁 ${d.name}`, () => showFolder(rootId, childPath)))
        })
        if (list.children.length === 0) {
          const empty = document.createElement('p')
          empty.className = 'empty-row'
          empty.textContent = t('files.noSubfolders')
          list.appendChild(empty)
        }
      }

      rootSelect.addEventListener('change', () => showFolder(rootSelect.value, ''))
      wrap.append(rootSelect, pathLine, list, error, footer)
      showFolder(target.root, target.path)
      return wrap
    }
  })
}

function pickerItem (label, onClick) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'files-picker-item'
  btn.textContent = label
  btn.addEventListener('click', onClick)
  return btn
}

// --- uploads ---

// One file at a time (queued), via XHR rather than fetch - fetch has no upload progress events. The
// body is the raw file (not multipart), streamed straight to disk by the API. Content-Type is forced to
// octet-stream: the browser would otherwise send the file's own type, and a .json upload would get
// swallowed by the API's JSON body parser instead of reaching the upload route.
function uploadFiles (fileList) {
  const files = [...fileList]
  if (files.length === 0) return
  const dest = { ...current }
  els.uploads.classList.remove('hidden')
  files.forEach((file) => {
    const row = uploadRow(file)
    uploadQueue = uploadQueue.then(() => uploadOne(file, dest, row, false))
  })
  uploadQueue = uploadQueue.then(() => {
    if (current.root === dest.root && current.path === dest.path) loadDir()
    loadRoots()
  })
}

function uploadRow (file) {
  const row = document.createElement('div')
  row.className = 'files-upload-row'
  const name = document.createElement('span')
  name.className = 'files-upload-name'
  name.textContent = file.name
  const bar = document.createElement('div')
  bar.className = 'progress-bar'
  const fill = document.createElement('div')
  fill.className = 'progress-bar-fill'
  fill.style.width = '0%'
  bar.appendChild(fill)
  const status = document.createElement('span')
  status.className = 'files-dim'
  status.textContent = t('files.upload.waiting')
  row.append(name, bar, status)
  els.uploads.appendChild(row)
  return { row, fill, status }
}

function uploadOne (file, dest, ui, overwrite) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api/files/upload?${query({ ...dest, name: file.name, ...(overwrite ? { overwrite: '1' } : {}) })}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('Accept-Language', getLanguage())
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return
      const pct = (event.loaded / event.total) * 100
      ui.fill.style.width = `${pct.toFixed(1)}%`
      ui.status.textContent = `${pct.toFixed(0)}% · ${fmtBytes(event.loaded)} / ${fmtBytes(event.total)}`
    })
    const finish = (ok, message) => {
      ui.fill.classList.toggle('danger', !ok)
      ui.fill.style.width = '100%'
      ui.status.textContent = message
      if (ok) setTimeout(() => removeUploadRow(ui.row), 4000)
      else ui.row.appendChild(actionButton(t('common.close'), 'btn-details', () => removeUploadRow(ui.row)))
      resolve()
    }
    xhr.addEventListener('load', () => {
      let data = null
      try { data = JSON.parse(xhr.responseText) } catch { }
      if (xhr.status === 409 && !overwrite) {
        if (window.confirm(t('files.confirmOverwrite', { name: file.name }))) {
          resolve(uploadOne(file, dest, ui, true))
        } else {
          finish(false, t('files.upload.skipped'))
        }
        return
      }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) finish(true, t('files.upload.done'))
      else finish(false, (data && data.error) || `HTTP ${xhr.status}`)
    })
    xhr.addEventListener('error', () => finish(false, t('files.upload.networkError')))
    xhr.send(file)
  })
}

function removeUploadRow (row) {
  row.remove()
  if (els.uploads.children.length === 0) els.uploads.classList.add('hidden')
}

function setupDragAndDrop () {
  let depth = 0
  const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files')
  els.panel.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth++
    els.dropOverlay.classList.remove('hidden')
  })
  els.panel.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault()
  })
  els.panel.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) els.dropOverlay.classList.add('hidden')
  })
  els.panel.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth = 0
    els.dropOverlay.classList.add('hidden')
    // Dropped folders show up as zero-byte "files" that can't actually be read - only plain files are
    // supported, so skip folders with a clear message instead of a confusing failed upload.
    const items = [...event.dataTransfer.items]
    const files = []
    let skippedFolders = 0
    items.forEach((item) => {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null
      if (entry && entry.isDirectory) { skippedFolders++; return }
      const file = item.getAsFile()
      if (file) files.push(file)
    })
    if (skippedFolders) showActionResult(false, t('files.foldersNotSupported'))
    uploadFiles(files)
  })
}

// --- init ---

function init () {
  els = {
    roots: document.getElementById('files-roots'),
    panel: document.getElementById('files-panel'),
    breadcrumb: document.getElementById('files-breadcrumb'),
    tbody: document.getElementById('files-tbody'),
    selectAll: document.getElementById('files-select-all'),
    selectionBar: document.getElementById('files-selection-bar'),
    selectionCount: document.getElementById('files-selection-count'),
    uploads: document.getElementById('files-uploads'),
    uploadInput: document.getElementById('files-upload-input'),
    dropOverlay: document.getElementById('files-drop-overlay'),
    showHidden: document.getElementById('files-show-hidden')
  }

  try { showHidden = localStorage.getItem(SHOW_HIDDEN_KEY) === '1' } catch { }
  els.showHidden.checked = showHidden
  els.showHidden.addEventListener('change', () => {
    showHidden = els.showHidden.checked
    try { localStorage.setItem(SHOW_HIDDEN_KEY, showHidden ? '1' : '0') } catch { }
    renderTable()
  })

  document.getElementById('files-refresh-btn').addEventListener('click', () => { loadRoots(); loadDir() })
  document.getElementById('files-mkdir-btn').addEventListener('click', mkdirUI)
  document.getElementById('files-upload-btn').addEventListener('click', () => els.uploadInput.click())
  els.uploadInput.addEventListener('change', () => {
    uploadFiles(els.uploadInput.files)
    els.uploadInput.value = ''
  })

  els.selectAll.addEventListener('change', () => {
    visibleEntries().forEach((e) => {
      if (els.selectAll.checked) selected.add(e.name)
      else selected.delete(e.name)
    })
    renderTable()
  })
  document.getElementById('files-move-selected-btn').addEventListener('click', () => moveUI(selectedVisibleNames()))
  document.getElementById('files-delete-selected-btn').addEventListener('click', () => deleteUI(selectedVisibleNames()))
  document.getElementById('files-clear-selection-btn').addEventListener('click', () => { selected.clear(); renderTable() })

  setupDragAndDrop()

  // Re-reads the disk list every time the screen is opened, so a disk plugged in since shows up.
  window.addEventListener('hashchange', () => {
    if (location.hash === '#files') loadRoots().then(loadDir)
  })
  window.addEventListener('pd-lang-changed', () => { renderRoots(); renderBreadcrumb(); renderTable() })

  current = readSavedLocation() || current
  loadRoots().then(loadDir)
}

defineView('pd-view-files', TEMPLATE_URL, init)
