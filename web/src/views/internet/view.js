import { defineView, renderChecksBar, showActionResult } from '../../core/dom.js'
import { drawSparkline, resampleHistory } from '../../core/charts.js'
import { fmtNumber, fmtDateTime } from '../../core/format.js'
import { t } from '../../core/i18n.js'

const TEMPLATE_URL = new URL('./template.html', import.meta.url)

const HISTORY_CHART_POINTS = 150

let els = null

function renderNow (internet) {
  if (!internet || !internet.available) {
    els.dot.className = 'dot dot-unknown'
    els.state.textContent = '--'
    els.ping.textContent = '--'
    els.avgLatency.textContent = '--'
    els.jitter.textContent = '--'
    els.loss.textContent = '--'
  } else {
    els.dot.className = `dot ${internet.connected ? 'dot-ok' : 'dot-error'}`
    els.state.textContent = internet.connected ? t('internet.now.connected') : t('internet.now.disconnected')
    els.ping.textContent = internet.connected ? fmtNumber(internet.latencyMs, 0, 'ms') : '--'
    els.avgLatency.textContent = fmtNumber(internet.avgLatencyMs, 0, 'ms')
    els.jitter.textContent = fmtNumber(internet.jitterMs, 0, 'ms')
    els.loss.textContent = `${internet.packetLossPercent}%`
  }

  els.download.textContent = fmtNumber(internet && internet.downloadMbps, 1, ' Mbps')
  els.upload.textContent = fmtNumber(internet && internet.uploadMbps, 1, ' Mbps')
  els.speedTestedAt.textContent = internet && internet.speedTestedAt ? fmtDateTime(internet.speedTestedAt) : t('internet.now.never')

  renderRecentBar((internet && internet.recentChecks) || [])

  els.speedtestBtn.disabled = !!(internet && internet.speedtestInFlight)
  if (internet && internet.speedtestInFlight) {
    els.speedtestBtn.textContent = t('internet.now.speedTesting')
  } else if (!els.speedtestBtn.dataset.userTriggered) {
    els.speedtestBtn.textContent = t('internet.now.speedTestBtn')
  }
}

function renderRecentBar (recentChecks) {
  els.recentBar.innerHTML = ''
  els.recentBar.appendChild(renderChecksBar(recentChecks, 'at'))
}

async function runSpeedtestNow () {
  els.speedtestBtn.disabled = true
  els.speedtestBtn.dataset.userTriggered = 'true'
  els.speedtestBtn.textContent = t('internet.now.speedTesting')
  try {
    const res = await fetch('/api/system/internet/speedtest', { method: 'POST' })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    renderNow(data.internet)
    showActionResult(true, t('internet.now.speedTestOk'))
  } catch (err) {
    showActionResult(false, t('internet.now.speedTestFailed', { error: err.message }))
  } finally {
    delete els.speedtestBtn.dataset.userTriggered
    els.speedtestBtn.disabled = false
    els.speedtestBtn.textContent = t('internet.now.speedTestBtn')
  }
}

window.addEventListener('pd-system-update', (event) => {
  if (!els) return
  renderNow(event.detail.internet)
})

async function fetchInternetHistory () {
  const hours = els.historyRange.value
  try {
    const res = await fetch(`/api/metrics/history?hours=${hours}`)
    const data = await res.json()
    if (!data.ok) return

    const withInternetData = data.samples.filter((s) => s.internetConnected !== null && s.internetConnected !== undefined)
    els.historyEmptyNote.classList.toggle('hidden', withInternetData.length >= 2)

    drawSparkline(els.chartLatency, resampleHistory(data.samples, 'internetLatencyMs', HISTORY_CHART_POINTS), '#a78bfa', HISTORY_CHART_POINTS)
    drawSparkline(els.chartAvailability, resampleHistory(data.samples, 'internetConnected', HISTORY_CHART_POINTS), '#35c46f', HISTORY_CHART_POINTS)

    if (withInternetData.length === 0) {
      els.historyUptimeSub.innerHTML = '&nbsp;'
    } else {
      const upCount = withInternetData.filter((s) => s.internetConnected).length
      els.historyUptimeSub.textContent = t('overview.internet.uptimeSummary', { percent: Math.round((upCount / withInternetData.length) * 100) })
    }
  } catch {
  }
}

function init () {
  els = {
    dot: document.getElementById('internet-now-dot'),
    state: document.getElementById('internet-now-state'),
    ping: document.getElementById('internet-now-ping'),
    avgLatency: document.getElementById('internet-now-avg-latency'),
    jitter: document.getElementById('internet-now-jitter'),
    loss: document.getElementById('internet-now-loss'),
    download: document.getElementById('internet-now-download'),
    upload: document.getElementById('internet-now-upload'),
    speedTestedAt: document.getElementById('internet-now-speed-tested-at'),
    speedtestBtn: document.getElementById('internet-speedtest-btn'),
    recentBar: document.getElementById('internet-recent-bar'),
    historyRange: document.getElementById('internet-history-range'),
    chartLatency: document.getElementById('internet-chart-latency'),
    chartAvailability: document.getElementById('internet-chart-availability'),
    historyUptimeSub: document.getElementById('internet-history-uptime-sub'),
    historyEmptyNote: document.getElementById('internet-history-empty-note')
  }

  els.speedtestBtn.addEventListener('click', runSpeedtestNow)
  els.historyRange.addEventListener('change', fetchInternetHistory)
  fetchInternetHistory()
  setInterval(fetchInternetHistory, 5 * 60 * 1000)

  fetch('/api/system', { cache: 'no-store' })
    .then((res) => res.json())
    .then((data) => renderNow(data.internet))
    .catch(() => {})

  window.addEventListener('pd-lang-changed', () => {
    fetchInternetHistory()
  })
}

defineView('pd-view-internet', TEMPLATE_URL, init)
