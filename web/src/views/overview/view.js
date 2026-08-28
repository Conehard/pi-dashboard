import { fmtNumber, fmtBytes, fmtTime, fmtDateTime, orDash } from '../../core/format.js'
import { stateClass, setConnectionState, showActionResult, defineView } from '../../core/dom.js'
import { drawSparkline, resampleHistory } from '../../core/charts.js'
import { t } from '../../core/i18n.js'

const TEMPLATE_URL = new URL('./template.html', import.meta.url)

const POLL_INTERVAL_MS = 2000
const HISTORY_MAX_POINTS = Math.ceil((5 * 60 * 1000) / POLL_INTERVAL_MS)

const history = {
  cpu: [],
  temp: [],
  mem: []
}

let overviewEls = null

function fmtDuration (seconds) {
  if (seconds === null || seconds === undefined) return '--'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (days > 0) parts.push(`${days}d`)
  if (days > 0 || hours > 0) parts.push(`${hours}h`)
  parts.push(`${minutes}m`)
  return parts.join(' ')
}

function progressBar (percent) {
  const value = percent === null || percent === undefined ? 0 : Math.min(100, Math.max(0, percent))
  const cls = value >= 90 ? 'danger' : value >= 70 ? 'warn' : ''
  const label = fmtNumber(percent, 0, '%')
  return `<span class="progress-bar"><span class="progress-bar-fill ${cls}" style="width:${value}%"></span></span>${label}`
}

function pushHistory (arr, value) {
  arr.push(value)
  if (arr.length > HISTORY_MAX_POINTS) arr.shift()
}

function renderSystem (system) {
  overviewEls.hostname.textContent = system.hostname || '--'

  overviewEls.cpuPercent.textContent = fmtNumber(system.cpuPercent, 1)
  overviewEls.cpuCores.textContent = orDash(system.cpuCount)

  if (system.temperature === null || system.temperature === undefined) {
    overviewEls.tempValue.textContent = t('overview.tempNA')
  } else {
    overviewEls.tempValue.textContent = fmtNumber(system.temperature, 1)
  }

  if (system.memory) {
    overviewEls.memPercent.textContent = fmtNumber(system.memory.percent, 1)
    overviewEls.memUsed.textContent = fmtBytes(system.memory.usedBytes)
    overviewEls.memTotal.textContent = fmtBytes(system.memory.totalBytes)
  } else {
    overviewEls.memPercent.textContent = '--'
    overviewEls.memUsed.textContent = '--'
    overviewEls.memTotal.textContent = '--'
  }

  if (system.uptime) {
    overviewEls.uptimeDays.textContent = system.uptime.days
    overviewEls.uptimeHours.textContent = system.uptime.hours
    overviewEls.uptimeMinutes.textContent = system.uptime.minutes
  } else {
    overviewEls.uptimeDays.textContent = '--'
    overviewEls.uptimeHours.textContent = '--'
    overviewEls.uptimeMinutes.textContent = '--'
  }

  if (system.loadavg) {
    overviewEls.load1.textContent = fmtNumber(system.loadavg.load1, 2)
    overviewEls.load5.textContent = fmtNumber(system.loadavg.load5, 2)
    overviewEls.load15.textContent = fmtNumber(system.loadavg.load15, 2)
  } else {
    overviewEls.load1.textContent = '--'
    overviewEls.load5.textContent = '--'
    overviewEls.load15.textContent = '--'
  }

  overviewEls.sysHostname.textContent = system.hostname || '--'
  overviewEls.sysOs.textContent = system.os || '--'
  overviewEls.sysKernel.textContent = system.kernel || '--'
  overviewEls.sysArch.textContent = system.arch || '--'
  overviewEls.sysCpus.textContent = orDash(system.cpuCount)
  overviewEls.sysMemTotal.textContent = system.memory ? fmtBytes(system.memory.totalBytes) : '--'
  overviewEls.sysUptime.textContent = system.uptime ? fmtDuration(system.uptime.seconds) : '--'

  pushHistory(history.cpu, system.cpuPercent)
  pushHistory(history.temp, system.temperature)
  pushHistory(history.mem, system.memory ? system.memory.percent : null)

  drawSparkline(document.getElementById('chart-cpu'), history.cpu, '#4f9cf9', HISTORY_MAX_POINTS)
  drawSparkline(document.getElementById('chart-temp'), history.temp, '#e6b93f', HISTORY_MAX_POINTS)
  drawSparkline(document.getElementById('chart-mem'), history.mem, '#35c46f', HISTORY_MAX_POINTS)
}

function renderStorage (storage) {
  if (!storage || storage.length === 0) {
    overviewEls.storageBody.innerHTML = `<tr><td colspan="5" class="empty-row">${t('common.noData')}</td></tr>`
    return
  }

  overviewEls.storageBody.innerHTML = storage.map(entry => `
    <tr>
      <td>${entry.label}</td>
      <td>${fmtBytes(entry.totalBytes)}</td>
      <td>${fmtBytes(entry.usedBytes)}</td>
      <td>${fmtBytes(entry.availableBytes)}</td>
      <td>${progressBar(entry.percent)}</td>
    </tr>
  `).join('')
}

function renderOverviewDocker (docker) {
  if (!docker || !docker.available) {
    overviewEls.dockerError.textContent = docker && docker.error ? docker.error : t('overview.docker.unavailable')
    overviewEls.dockerError.classList.remove('hidden')
    overviewEls.dockerBody.innerHTML = `<tr><td colspan="7" class="empty-row">${t('common.noData')}</td></tr>`
    return
  }

  overviewEls.dockerError.classList.add('hidden')

  if (docker.containers.length === 0) {
    overviewEls.dockerBody.innerHTML = `<tr><td colspan="7" class="empty-row">${t('overview.docker.noContainersShort')}</td></tr>`
    return
  }

  overviewEls.dockerBody.innerHTML = docker.containers.map(c => `
    <tr>
      <td>${c.name}</td>
      <td>${c.image}</td>
      <td><span class="state-badge ${stateClass(c.state)}">${c.state}</span></td>
      <td>${c.status || '--'}</td>
      <td>${fmtNumber(c.cpuPercent, 1, '%')}</td>
      <td>${fmtBytes(c.memUsageBytes)}</td>
      <td>${orDash(c.pids)}</td>
    </tr>
  `).join('')
}

function renderMiner (miner) {
  if (!miner || !miner.present) {
    overviewEls.minerBody.innerHTML = `<p class="empty-row">${t('overview.miner.notPresent')}</p>`
    return
  }

  overviewEls.minerBody.innerHTML = `
    <div class="miner-grid">
      <div class="miner-item">
        <span class="label">${t('common.state')}</span>
        <span class="value"><span class="state-badge ${stateClass(miner.state)}">${miner.state}</span></span>
      </div>
      <div class="miner-item">
        <span class="label">${t('overview.miner.status')}</span>
        <span class="value">${miner.status || '--'}</span>
      </div>
      <div class="miner-item">
        <span class="label">${t('common.image')}</span>
        <span class="value">${miner.image || '--'}</span>
      </div>
      <div class="miner-item">
        <span class="label">${t('common.cpu')}</span>
        <span class="value">${fmtNumber(miner.cpuPercent, 1, '%')}</span>
      </div>
      <div class="miner-item">
        <span class="label">${t('common.ram')}</span>
        <span class="value">${fmtBytes(miner.memUsageBytes)}</span>
      </div>
      <div class="miner-item">
        <span class="label">${t('overview.miner.containerUptime')}</span>
        <span class="value">${fmtDuration(miner.uptimeSeconds)}</span>
      </div>
      <div class="miner-item">
        <span class="label">${t('overview.miner.hashrate')}</span>
        <span class="value">${miner.hashrate || '--'}</span>
      </div>
    </div>
  `
}

function fmtRate (bytesPerSec) {
  if (bytesPerSec === null || bytesPerSec === undefined) return '--'
  return `${fmtBytes(bytesPerSec)}/s`
}

let lastNetworkSnapshot = null

function renderNetwork (network) {
  lastNetworkSnapshot = network || null

  if (!network || !network.available) {
    overviewEls.netRx.textContent = '--'
    overviewEls.netTx.textContent = '--'
  } else {
    overviewEls.netRx.textContent = fmtRate(network.totalRxBps)
    overviewEls.netTx.textContent = fmtRate(network.totalTxBps)
  }

  if (inspectorOpenFor === 'network') renderNetworkTable()
}

const INTERNET_LATENCY_WARN_MS = 100
const INTERNET_LOSS_WARN_PERCENT = 10

function renderInternet (internet) {
  if (!internet || !internet.available) {
    overviewEls.internetPing.textContent = '--'
    overviewEls.internetPing.className = ''
    overviewEls.internetLoss.textContent = '--'
    overviewEls.internetDown.textContent = '--'
    overviewEls.internetUp.textContent = '--'
    return
  }

  const unstable = internet.packetLossPercent > INTERNET_LOSS_WARN_PERCENT ||
    (internet.avgLatencyMs !== null && internet.avgLatencyMs > INTERNET_LATENCY_WARN_MS)

  overviewEls.internetPing.textContent = internet.connected ? fmtNumber(internet.latencyMs, 0) : '--'
  overviewEls.internetPing.className = !internet.connected ? 'text-danger' : (unstable ? 'text-warn' : 'text-ok')
  overviewEls.internetLoss.textContent = internet.packetLossPercent
  overviewEls.internetDown.textContent = fmtNumber(internet.downloadMbps, 1)
  overviewEls.internetUp.textContent = fmtNumber(internet.uploadMbps, 1)
}

function renderCloudflared (cloudflared) {
  if (!cloudflared || !cloudflared.available) {
    overviewEls.tunnelCard.classList.add('hidden')
    return
  }
  overviewEls.tunnelCard.classList.remove('hidden')
  overviewEls.tunnelState.textContent = cloudflared.connected ? t('overview.tunnel.connected') : t('overview.tunnel.disconnected')
  overviewEls.tunnelState.className = `card-value card-value--network ${cloudflared.connected ? 'text-ok' : 'text-danger'}`
  overviewEls.tunnelSub.textContent = cloudflared.connected
    ? t('overview.tunnel.activeConnections', { n: cloudflared.haConnections })
    : t('overview.tunnel.noEdgeConnection')
}

function renderTailscale (tailscale) {
  if (!tailscale || !tailscale.available) {
    overviewEls.tailscaleCard.classList.add('hidden')
    return
  }
  overviewEls.tailscaleCard.classList.remove('hidden')
  overviewEls.tailscaleState.textContent = tailscale.connected ? t('overview.tailscale.connected') : t('overview.tailscale.disconnected')
  overviewEls.tailscaleState.className = `card-value card-value--network ${tailscale.connected ? 'text-ok' : 'text-danger'}`
  overviewEls.tailscaleSub.textContent = tailscale.connected
    ? t('overview.tailscale.peersOnline', { online: tailscale.peerOnlineCount, total: tailscale.peerCount })
    : (tailscale.backendState || '--')
}

async function pollOverview () {
  try {
    const res = await fetch('/api/system', { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()

    setConnectionState('ok')
    overviewEls.lastUpdate.textContent = fmtTime(data.timestamp)

    renderSystem(data.system || {})
    renderStorage(data.storage)
    renderOverviewDocker(data.docker)
    renderMiner(data.miner)
    renderNetwork(data.network)
    renderInternet(data.internet)
    renderCloudflared(data.cloudflared)
    renderTailscale(data.tailscale)

    window.dispatchEvent(new CustomEvent('pd-system-update', { detail: data }))
  } catch (err) {
    setConnectionState('error')
  }
}

const HISTORY_CHART_POINTS = HISTORY_MAX_POINTS

async function fetchMetricsHistory () {
  const hours = document.getElementById('history-range').value
  try {
    const res = await fetch(`/api/metrics/history?hours=${hours}`)
    const data = await res.json()
    if (!data.ok) return

    const emptyNote = document.getElementById('history-empty-note')
    emptyNote.classList.toggle('hidden', data.samples.length >= 2)

    drawSparkline(document.getElementById('chart-history-cpu'), resampleHistory(data.samples, 'cpuPercent', HISTORY_CHART_POINTS), '#4f9cf9', HISTORY_CHART_POINTS)
    drawSparkline(document.getElementById('chart-history-temp'), resampleHistory(data.samples, 'tempC', HISTORY_CHART_POINTS), '#e6b93f', HISTORY_CHART_POINTS)
    drawSparkline(document.getElementById('chart-history-mem'), resampleHistory(data.samples, 'memPercent', HISTORY_CHART_POINTS), '#35c46f', HISTORY_CHART_POINTS)
    drawSparkline(document.getElementById('chart-history-internet'), resampleHistory(data.samples, 'internetConnected', HISTORY_CHART_POINTS), '#a78bfa', HISTORY_CHART_POINTS)

    const withInternetData = data.samples.filter((s) => s.internetConnected !== null && s.internetConnected !== undefined)
    const internetSub = document.getElementById('history-internet-sub')
    if (withInternetData.length === 0) {
      internetSub.innerHTML = '&nbsp;'
    } else {
      const upCount = withInternetData.filter((s) => s.internetConnected).length
      internetSub.textContent = t('overview.internet.uptimeSummary', { percent: Math.round((upCount / withInternetData.length) * 100) })
    }
  } catch {
  }
}

async function fetchSmartHealth () {
  const panel = document.getElementById('smart-panel')
  try {
    const res = await fetch('/api/smart-health')
    const data = await res.json()
    if (!data.ok || !data.available || data.devices.length === 0) {
      panel.classList.add('hidden')
      return
    }
    panel.classList.remove('hidden')
    renderSmartDevices(data.devices, data.stale)
  } catch {
    panel.classList.add('hidden')
  }
}

function renderSmartDevices (devices, stale) {
  const box = document.getElementById('smart-devices')
  box.innerHTML = ''

  const scroll = document.createElement('div')
  scroll.className = 'table-scroll'

  const table = document.createElement('table')
  table.className = 'data-table'
  table.innerHTML = `
    <thead><tr><th>${t('overview.smart.device')}</th><th>${t('overview.smart.health')}</th><th>${t('overview.smart.temperature')}</th><th>${t('overview.smart.poweredOn')}</th><th>${t('overview.smart.reallocated')}</th></tr></thead>
    <tbody></tbody>
  `
  const tbody = table.querySelector('tbody')
  devices.forEach((d) => {
    const row = document.createElement('tr')
    const healthBadge = d.healthy === true
      ? `<span class="state-badge state-running">${t('overview.smart.ok')}</span>`
      : d.healthy === false
        ? `<span class="state-badge state-exited">${t('overview.smart.failed')}</span>`
        : '<span class="state-badge state-other">--</span>'
    row.innerHTML = `
      <td>${d.device}</td>
      <td>${healthBadge}</td>
      <td>${orDash(d.temperatureC, (v) => v + '°C')}</td>
      <td>${orDash(d.powerOnHours, (v) => t('overview.smart.days', { n: Math.round(v / 24) }))}</td>
      <td>${orDash(d.reallocatedSectors)}</td>
    `
    tbody.appendChild(row)
  })
  scroll.appendChild(table)
  box.appendChild(scroll)

  if (stale) {
    const note = document.createElement('p')
    note.className = 'card-sub'
    note.textContent = t('common.staleHostData')
    box.appendChild(note)
  }
}

let inspectorOpenFor = null
let processPollTimer = null
let resourceInspectorEls = null

function closeResourceInspector () {
  inspectorOpenFor = null
  resourceInspectorEls.panel.classList.add('hidden')
  if (processPollTimer) {
    clearInterval(processPollTimer)
    processPollTimer = null
  }
}

function renderProcessTable (list, kind) {
  resourceInspectorEls.thead.innerHTML = `
    <tr><th>${t('overview.process.process')}</th><th>${t('overview.process.pid')}</th><th>${kind === 'cpu' ? t('common.cpu') : t('common.ram')}</th></tr>
  `

  if (!list || list.length === 0) {
    resourceInspectorEls.tbody.innerHTML = `<tr><td colspan="3" class="empty-row">${t('common.noData')}</td></tr>`
    return
  }

  resourceInspectorEls.tbody.innerHTML = list.map((p) => `
    <tr>
      <td>${p.name}</td>
      <td>${p.pid}</td>
      <td>${kind === 'cpu' ? fmtNumber(p.cpuPercent, 1, '%') : fmtBytes(p.rssBytes)}</td>
    </tr>
  `).join('')
}

async function fetchAndRenderProcesses (kind) {
  try {
    const res = await fetch('/api/processes/top')
    const data = await res.json()
    if (!res.ok || !data.ok || !data.available) {
      resourceInspectorEls.tbody.innerHTML = `<tr><td class="empty-row">${t('overview.process.unavailable')}</td></tr>`
      return
    }
    renderProcessTable(kind === 'cpu' ? data.topCpu : data.topMem, kind)
  } catch (err) {
    resourceInspectorEls.tbody.innerHTML = `<tr><td class="empty-row">${t('common.loadFailed', { error: err.message })}</td></tr>`
  }
}

function renderNetworkTable () {
  resourceInspectorEls.thead.innerHTML = `
    <tr><th>${t('overview.network.table.interface')}</th><th>${t('overview.network.table.rxNow')}</th><th>${t('overview.network.table.txNow')}</th><th>${t('overview.network.table.rxTotal')}</th><th>${t('overview.network.table.txTotal')}</th></tr>
  `

  const interfaces = lastNetworkSnapshot && lastNetworkSnapshot.interfaces
  if (!interfaces || interfaces.length === 0) {
    resourceInspectorEls.tbody.innerHTML = `<tr><td colspan="5" class="empty-row">${t('common.noData')}</td></tr>`
    return
  }

  resourceInspectorEls.tbody.innerHTML = interfaces.map((i) => `
    <tr>
      <td>${i.name}</td>
      <td>${fmtRate(i.rxBps)}</td>
      <td>${fmtRate(i.txBps)}</td>
      <td>${fmtBytes(i.rxTotalBytes)}</td>
      <td>${fmtBytes(i.txTotalBytes)}</td>
    </tr>
  `).join('')
}

const RESOURCE_TITLE_KEYS = {
  cpu: 'overview.resourceTitles.cpu',
  mem: 'overview.resourceTitles.mem',
  network: 'overview.resourceTitles.network'
}

function openResourceInspector (kind) {
  inspectorOpenFor = kind
  resourceInspectorEls.title.textContent = t(RESOURCE_TITLE_KEYS[kind])
  resourceInspectorEls.panel.classList.remove('hidden')
  resourceInspectorEls.panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

  if (processPollTimer) {
    clearInterval(processPollTimer)
    processPollTimer = null
  }

  if (kind === 'network') {
    renderNetworkTable()
    return
  }

  resourceInspectorEls.tbody.innerHTML = `<tr><td class="empty-row">${t('common.loading')}</td></tr>`
  fetchAndRenderProcesses(kind)
  processPollTimer = setInterval(() => fetchAndRenderProcesses(kind), 3000)
}

function init () {
  overviewEls = {
    hostname: document.getElementById('sidebar-hostname'),
    lastUpdate: document.getElementById('last-update'),

    cpuPercent: document.getElementById('cpu-percent'),
    cpuCores: document.getElementById('cpu-cores'),
    tempValue: document.getElementById('temp-value'),
    tempSub: document.getElementById('temp-sub'),
    memPercent: document.getElementById('mem-percent'),
    memUsed: document.getElementById('mem-used'),
    memTotal: document.getElementById('mem-total'),
    uptimeDays: document.getElementById('uptime-days'),
    uptimeHours: document.getElementById('uptime-hours'),
    uptimeMinutes: document.getElementById('uptime-minutes'),
    netRx: document.getElementById('net-rx'),
    netTx: document.getElementById('net-tx'),
    internetPing: document.getElementById('internet-ping'),
    internetLoss: document.getElementById('internet-loss'),
    internetDown: document.getElementById('internet-down'),
    internetUp: document.getElementById('internet-up'),

    load1: document.getElementById('load1'),
    load5: document.getElementById('load5'),
    load15: document.getElementById('load15'),

    sysHostname: document.getElementById('sys-hostname'),
    sysOs: document.getElementById('sys-os'),
    sysKernel: document.getElementById('sys-kernel'),
    sysArch: document.getElementById('sys-arch'),
    sysCpus: document.getElementById('sys-cpus'),
    sysMemTotal: document.getElementById('sys-mem-total'),
    sysUptime: document.getElementById('sys-uptime'),
    sysUpdates: document.getElementById('sys-updates'),

    storageBody: document.getElementById('storage-body'),
    dockerBody: document.getElementById('docker-body'),
    dockerError: document.getElementById('overview-docker-error'),
    minerBody: document.getElementById('miner-body'),

    tunnelCard: document.getElementById('card-tunnel'),
    tunnelState: document.getElementById('tunnel-state'),
    tunnelSub: document.getElementById('tunnel-sub'),

    tailscaleCard: document.getElementById('card-tailscale'),
    tailscaleState: document.getElementById('tailscale-state'),
    tailscaleSub: document.getElementById('tailscale-sub')
  }

  pollOverview()
  setInterval(pollOverview, POLL_INTERVAL_MS)

  document.getElementById('history-range').addEventListener('change', fetchMetricsHistory)
  fetchMetricsHistory()
  setInterval(fetchMetricsHistory, 5 * 60 * 1000)

  fetchSmartHealth()
  setInterval(fetchSmartHealth, 5 * 60 * 1000)

  resourceInspectorEls = {
    panel: document.getElementById('resource-inspector'),
    title: document.getElementById('resource-inspector-title'),
    thead: document.getElementById('resource-inspector-thead'),
    tbody: document.getElementById('resource-inspector-tbody'),
    close: document.getElementById('resource-inspector-close')
  }
  resourceInspectorEls.close.addEventListener('click', closeResourceInspector)

  document.getElementById('card-cpu').addEventListener('click', () => openResourceInspector('cpu'))
  document.getElementById('card-mem').addEventListener('click', () => openResourceInspector('mem'))
  document.getElementById('card-network').addEventListener('click', () => openResourceInspector('network'))

  document.getElementById('card-internet').addEventListener('click', () => { location.hash = '#internet' })

  document.getElementById('reboot-pi-btn').addEventListener('click', async () => {
    if (!window.confirm(t('overview.system.confirmReboot'))) return

    const btn = document.getElementById('reboot-pi-btn')
    btn.disabled = true
    btn.textContent = t('overview.system.rebooting')
    try {
      const res = await fetch('/api/system/reboot', { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      showActionResult(true, t('overview.system.rebootTriggered'))
    } catch (err) {
      showActionResult(false, t('overview.system.rebootFailed', { error: err.message }))
      btn.disabled = false
      btn.textContent = t('overview.system.rebootBtn')
    }
  })

  window.addEventListener('pd-lang-changed', () => {
    pollOverview()
    fetchMetricsHistory()
    fetchSmartHealth()
    if (inspectorOpenFor) openResourceInspector(inspectorOpenFor)
  })
}

defineView('pd-view-overview', TEMPLATE_URL, init)
