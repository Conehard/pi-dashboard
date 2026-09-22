// Tuya devices screen (#tuya) - a schema-driven device list: every control shown for a device comes
// from that device's own DPS schema (GET /api/tuya/devices' `schema`/`dps`), not from any hardcoded
// per-category logic here - a brand new Tuya device type this codebase has never seen still gets a
// reasonable generic control for each of its functions. See docs/plans/tuya-panel.md Phases 7/10/11.
//
// Also hosts the Automations panel (Phase 14) - a user-defined "when this DPS becomes X, do these
// actions" rule list. Kept in this same file/screen rather than a new top-level one since its only
// trigger source today is Tuya devices (see the plan for why).
import { actionButton, defineView, showActionResult } from '../../core/dom.js'
import { openModal } from '../../core/modal.js'
import { fmtDateTime } from '../../core/format.js'
import { t } from '../../core/i18n.js'

const TEMPLATE_URL = new URL('./template.html', import.meta.url)
const POLL_INTERVAL_MS = 10000
// Was 5min - way too tight for an event-driven sensor (door/window contact, motion) that only ever
// reports on a state *change*, not periodically - confirmed live (2026-09-14) these don't even answer
// an on-demand query, Tuya's cloud only hears from them when something actually happens. A door that's
// stayed shut for an hour isn't "gone quiet" in any broken sense, so read "no update yet" generously -
// 24h is about catching a sensor that's genuinely dead (flat battery, fell off the frame), not
// second-guessing a value that simply hasn't needed to change.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000
const HIDE_OFFLINE_KEY = 'pi-dashboard:tuyaHideOffline'
const MAX_READING_VALUE_LENGTH = 120 // longer than this and it's some internal blob (a base64 snapshot,
// an event payload), not a human reading - see docs/plans/tuya-panel.md Phase 10

// Common, standard Tuya DPS codes, spelled out in plain language - covers the categories this codebase
// has actually seen live (sockets/switches/lights/cameras/door+temperature sensors/a Zigbee gateway/an
// intercom) plus other widely-used standard codes. Anything not listed here still renders fine (see
// dpLabel()'s fallback below) - this is a readability nicety, not a requirement for a device to work.
const DP_LABELS = {
  switch_1: 'Switch', switch_2: 'Switch 2', switch_3: 'Switch 3', switch_led: 'Switch', switch: 'Switch',
  countdown_1: 'Countdown', countdown_2: 'Countdown 2', countdown: 'Countdown',
  relay_status: 'Power-on behavior', light_mode: 'Indicator light',
  switch_inching: 'Momentary switch', switch_type: 'Switch type', child_lock: 'Child lock',
  add_ele: 'Energy used', cur_current: 'Current', cur_power: 'Power', cur_voltage: 'Voltage', fault: 'Fault code',
  doorcontact_state: 'Contact', battery_percentage: 'Battery', battery_state: 'Battery',
  va_temperature: 'Temperature', va_humidity: 'Humidity', cur_temp: 'Temperature', cur_humidity: 'Humidity',
  temp_value: 'Temperature', humidity_value: 'Humidity', bright_value: 'Brightness', bright_value_v2: 'Brightness',
  colour_data: 'Color', colour_data_v2: 'Color', work_mode: 'Mode', mode: 'Mode', temp_unit_convert: 'Unit',
  basic_indicator: 'Status light', basic_flip: 'Flip image', basic_osd: 'Timestamp overlay',
  basic_nightvision: 'Night vision', basic_private: 'Privacy mode', basic_anti_flicker: 'Anti-flicker',
  basic_device_volume: 'Volume', motion_switch: 'Motion detection', motion_sensitivity: 'Motion sensitivity',
  motion_area_switch: 'Motion zone', motion_area: 'Motion zone area', motion_tracking: 'Motion tracking',
  record_switch: 'Recording', record_mode: 'Recording mode', siren_switch: 'Siren',
  decibel_switch: 'Sound detection', decibel_sensitivity: 'Sound sensitivity', floodlight_switch: 'Floodlight',
  nightvision_mode: 'Night vision mode', ptz_control: 'Pan/tilt', ptz_stop: 'Stop pan/tilt',
  ptz_calibration: 'Calibrate pan/tilt', sd_storge: 'SD card usage', sd_status: 'SD card status',
  sd_format: 'Format SD card', sd_format_state: 'SD format status', device_restart: 'Restart device',
  pir_switch: 'PIR sensor', wireless_electricity: 'Battery', wireless_powermode: 'Power mode',
  wireless_lowpower: 'Low battery threshold', wireless_awake: 'Awake', doorbell_active: 'Doorbell pressed',
  alarm_message: 'Alarm event', initiative_message: 'Event snapshot', movement_detect_pic: 'Motion snapshot',
  doorbell_pic: 'Doorbell snapshot'
}

// Same idea as DP_LABELS, for the `category` field - covers common consumer categories, falls back to
// the raw code (a Tuya-assigned short id, e.g. "wsdcg") for anything not listed.
const CATEGORY_LABELS = {
  cz: 'Sockets', kg: 'Switches', pc: 'Power strips', dd: 'Light strips', dj: 'Lights', xdd: 'Ceiling lights',
  fs: 'Fans', kt: 'Air conditioners', qn: 'Heaters', sp: 'Cameras', dghsxj: 'Video doorbells',
  mcs: 'Door/window sensors', wsdcg: 'Temperature/humidity sensors', pir: 'Motion sensors',
  ldcg: 'Illuminance sensors', ywbj: 'Smoke detectors', rqbj: 'Gas detectors', sos: 'Emergency buttons',
  wg2: 'Gateways', zndb: 'Smart hubs', tdq: 'Dimmer switches', mal: 'Smart locks', cl: 'Curtains',
  cs: 'Dehumidifiers', jsq: 'Humidifiers'
}

// Same idea again, for common *values* (mostly Enum options) - so a control/reading shows "Last state"
// instead of the raw "last". Deliberately modest - falls back to a Title-Cased version of the raw
// value (if it looks like a snake_case word) or the raw value itself otherwise.
const VALUE_LABELS = {
  power_off: 'Off', power_on: 'On', last: 'Last state', flip: 'Flip switch', sync: 'Sync with app',
  button: 'Momentary button', relay: 'Follows relay', pos: 'Position indicator', none: 'Off',
  auto: 'Automatic', ir_mode: 'Infrared'
}

// Boolean DPS codes that don't mean "on/off" - showing "on"/"off" for a door sensor reads as
// inverted/confusing even when the underlying `true`/`false` is technically correct (a door has no
// "on" state). `[trueKey, falseKey]` i18n keys, checked before falling back to tuya.valueOn/valueOff.
// `doorcontact_state`: confirmed against Tuya's own Standard Status Set for the "mcs" (contact sensor)
// category - `true` is documented as open, `false` as closed - not reverse-engineered from one report.
const BOOLEAN_VALUE_LABELS = {
  doorcontact_state: ['tuya.valueOpen', 'tuya.valueClosed']
}

// A function counts as "primary" (shown right on the compact card, not tucked into the modal's
// Advanced section) if it's the overwhelmingly common single-main-switch code - confirmed live across
// this account's own sockets/switches/lights (see docs/plans/tuya-panel.md Phase 1).
const PRIMARY_CODES = new Set(['switch', 'switch_1', 'switch_led'])

function dpLabel (code) {
  return DP_LABELS[code] || code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function categoryLabel (code) {
  return CATEGORY_LABELS[code] || (code ? code.toUpperCase() : '?')
}

function valueLabel (raw) {
  const key = String(raw)
  if (VALUE_LABELS[key]) return VALUE_LABELS[key]
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/i.test(key)) return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return key
}

function parseSpec (rawValues) {
  try {
    return JSON.parse(rawValues || '{}')
  } catch {
    return {}
  }
}

function scaledNumber (value, spec) {
  const scale = spec.scale ? 10 ** spec.scale : 1
  const n = Number(value) / scale
  return scale === 1 ? n : Number(n.toFixed(spec.scale))
}

function formatDpsValue (item, value) {
  if (value === undefined || value === null) return '--'
  const spec = parseSpec(item.values)
  if (item.type === 'Boolean') {
    const override = BOOLEAN_VALUE_LABELS[item.code]
    if (override) return t(value ? override[0] : override[1])
    return value ? t('tuya.valueOn') : t('tuya.valueOff')
  }
  if (item.type === 'Integer') {
    const n = scaledNumber(value, spec)
    return spec.unit ? `${n} ${spec.unit}` : String(n)
  }
  if (item.type === 'Enum') return valueLabel(value)
  return String(value)
}

function primaryFunction (device) {
  return (device.schema.functions || []).find((f) => f.type === 'Boolean' && PRIMARY_CODES.has(f.code)) || null
}

// Every code a device has, functions first (controllable) then any status-only ones (sensors) not
// already covered - used by the automations trigger picker, which can watch a read-only reading too.
function deviceAllCodes (device) {
  if (!device) return []
  const map = new Map()
  ;(device.schema.functions || []).forEach((f) => map.set(f.code, f))
  ;(device.schema.status || []).forEach((s) => { if (!map.has(s.code)) map.set(s.code, s) })
  return [...map.values()]
}

let showHidden = false
let hideOffline = true
let container = null
let latestDevices = [] // last fetched device list, reused by the automations form's device/code pickers

// --- shared API helper ---

async function apiCall (path, options) {
  const res = await fetch(path, options)
  const data = await res.json().catch(() => null)
  if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data
}

// --- device actions ---

async function sendCommand (device, code, value, { revert } = {}) {
  try {
    await apiCall(`/api/tuya/devices/${device.id}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, value })
    })
    // Deliberately not refetching here: the cloud poller (up to ~30s cadence, see
    // features/tuya/poller.js) is what actually confirms the new value - refetching immediately would
    // just show the pre-command state again and look like the click did nothing. The control already
    // reflects the new value (it's what the user just set); the next natural poll reconciles it either
    // way once Tuya's own status catches up.
  } catch (err) {
    showActionResult(false, t('tuya.commandFailed', { error: err.message }))
    if (revert) revert()
  }
}

async function renameDeviceUI (device) {
  const name = prompt(t('tuya.renamePrompt'), device.name)
  if (!name || !name.trim() || name.trim() === device.name) return
  try {
    await apiCall(`/api/tuya/devices/${device.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    })
    fetchDevices()
  } catch (err) {
    showActionResult(false, err.message)
  }
}

async function toggleHiddenUI (device) {
  try {
    await apiCall(`/api/tuya/devices/${device.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: !device.hidden })
    })
    fetchDevices()
  } catch (err) {
    showActionResult(false, err.message)
  }
}

async function removeDeviceUI (device) {
  if (!confirm(t('tuya.confirmRemove', { name: device.name }))) return
  try {
    await apiCall(`/api/tuya/devices/${device.id}`, { method: 'DELETE' })
    fetchDevices()
  } catch (err) {
    showActionResult(false, err.message)
  }
}

// Phase 12 - forces one immediate read of just this device instead of waiting for the next tick.
// `onDone` lets the modal re-render itself in place with the fresh device, rather than closing it.
async function refreshDeviceUI (device, onDone) {
  try {
    const data = await apiCall(`/api/tuya/devices/${device.id}/refresh`, { method: 'POST' })
    if (onDone) onDone(data.device)
    fetchDevices()
  } catch (err) {
    showActionResult(false, t('tuya.refreshFailed', { error: err.message }))
  }
}

// --- schema-driven controls (used by both device cards/modal and the automations form) ---

function renderBooleanControl (device, fn, value) {
  const label = document.createElement('label')
  label.className = 'settings-toggle tuya-control-toggle'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.className = 'switch-input'
  input.checked = !!value
  const sw = document.createElement('span')
  sw.className = 'switch'
  const text = document.createElement('span')
  text.className = 'settings-toggle-label'
  const title = document.createElement('span')
  title.className = 'settings-toggle-title'
  title.textContent = dpLabel(fn.code)
  text.appendChild(title)
  label.append(input, sw, text)

  input.addEventListener('change', () => {
    const newValue = input.checked
    sendCommand(device, fn.code, newValue, { revert: () => { input.checked = !newValue } })
  })
  return label
}

function renderRangeControl (device, fn, value, spec) {
  const row = document.createElement('div')
  row.className = 'job-form-row tuya-control-row'

  const label = document.createElement('span')
  label.className = 'card-sub tuya-control-label'
  label.textContent = dpLabel(fn.code)

  const input = document.createElement('input')
  input.type = 'range'
  input.className = 'tuya-range'
  input.min = spec.min ?? 0
  input.max = spec.max ?? 100
  input.step = spec.step || 1
  const initial = value ?? spec.min ?? 0
  input.value = initial

  const valueLabelEl = document.createElement('span')
  valueLabelEl.className = 'card-sub'
  const fmt = (raw) => spec.unit ? `${scaledNumber(raw, spec)} ${spec.unit}` : String(scaledNumber(raw, spec))
  valueLabelEl.textContent = fmt(initial)

  input.addEventListener('input', () => { valueLabelEl.textContent = fmt(input.value) })
  input.addEventListener('change', () => {
    const previous = initial
    sendCommand(device, fn.code, Number(input.value), {
      revert: () => { input.value = previous; valueLabelEl.textContent = fmt(previous) }
    })
  })

  row.append(label, input, valueLabelEl)
  return row
}

function renderEnumControl (device, fn, value, spec) {
  const row = document.createElement('div')
  row.className = 'job-form-row tuya-control-row'

  const label = document.createElement('span')
  label.className = 'card-sub tuya-control-label'
  label.textContent = dpLabel(fn.code)

  const select = document.createElement('select')
  ;(spec.range || []).forEach((opt) => {
    const option = document.createElement('option')
    option.value = opt
    option.textContent = valueLabel(opt)
    if (opt === value) option.selected = true
    select.appendChild(option)
  })

  select.addEventListener('change', () => {
    const previous = value
    sendCommand(device, fn.code, select.value, {
      revert: () => { select.value = previous }
    })
  })

  row.append(label, select)
  return row
}

// Fallback for String/Json/Raw/anything else the schema declares - a plain editable field with an
// explicit Send button rather than firing on every keystroke or blur. Covers device types this
// codebase has no specific renderer for, instead of hiding the control entirely.
function renderGenericControl (device, fn, value) {
  const row = document.createElement('div')
  row.className = 'job-form-row tuya-control-row'

  const label = document.createElement('span')
  label.className = 'card-sub tuya-control-label'
  label.textContent = dpLabel(fn.code)

  const input = document.createElement('input')
  input.type = 'text'
  input.value = value !== undefined && value !== null ? String(value) : ''
  input.placeholder = fn.type || ''

  const sendBtn = actionButton(t('common.save'), 'btn-secondary', () => {
    sendCommand(device, fn.code, input.value)
  })

  row.append(label, input, sendBtn)
  return row
}

function renderControl (device, fn) {
  const value = device.dps ? device.dps[fn.code] : undefined
  const spec = parseSpec(fn.values)
  if (fn.type === 'Boolean') return renderBooleanControl(device, fn, value)
  if (fn.type === 'Integer' && spec.min !== undefined && spec.max !== undefined) return renderRangeControl(device, fn, value, spec)
  if (fn.type === 'Enum' && Array.isArray(spec.range) && spec.range.length) return renderEnumControl(device, fn, value, spec)
  return renderGenericControl(device, fn, value)
}

// A standalone value-picker, not tied to sending a command - used by the automations form for both the
// trigger's "becomes ___" value and a tuya_command action's value. Same type-driven logic as the
// controls above, just returning { el, getValue() } instead of wiring a live sendCommand() call.
function renderValueField (schemaItem, initialValue) {
  const spec = schemaItem ? parseSpec(schemaItem.values) : {}
  if (schemaItem && schemaItem.type === 'Boolean') {
    const override = BOOLEAN_VALUE_LABELS[schemaItem.code]
    const onLabel = override ? t(override[0]) : t('tuya.valueOn')
    const offLabel = override ? t(override[1]) : t('tuya.valueOff')
    const select = document.createElement('select')
    ;[['true', onLabel], ['false', offLabel]].forEach(([v, label]) => {
      const o = document.createElement('option')
      o.value = v
      o.textContent = label
      select.appendChild(o)
    })
    select.value = String(initialValue ?? true)
    return { el: select, getValue: () => select.value === 'true' }
  }
  if (schemaItem && schemaItem.type === 'Enum' && Array.isArray(spec.range) && spec.range.length) {
    const select = document.createElement('select')
    spec.range.forEach((opt) => {
      const o = document.createElement('option')
      o.value = opt
      o.textContent = valueLabel(opt)
      select.appendChild(o)
    })
    if (initialValue !== undefined) select.value = initialValue
    return { el: select, getValue: () => select.value }
  }
  const input = document.createElement('input')
  input.type = schemaItem && schemaItem.type === 'Integer' ? 'number' : 'text'
  input.value = initialValue !== undefined && initialValue !== null ? String(initialValue) : ''
  return {
    el: input,
    getValue: () => (schemaItem && schemaItem.type === 'Integer' ? Number(input.value) : input.value)
  }
}

// --- status/freshness ---

// Same exclusion as features/tuya/local.js's NO_LOCAL_PROTOCOL_CATEGORIES and poller.js's
// `localCapable` check - a camera has a real `local_key` (Tuya's cloud hands one out for it same as
// any WiFi device) but never actually gets locally probed, so treating it as local-capable here would
// read its flaky cloud `online` flag as gospel instead of the freshness-based signal below. Found live
// (2026-09-14): this exact mismatch was the bug behind a camera showing "offline" while genuinely on.
const CLOUD_ONLY_CATEGORIES = new Set(['sp'])

function statusInfo (device) {
  // Devices with their own LAN key (and not a camera - see CLOUD_ONLY_CATEGORIES above) get a real
  // online/offline signal from the fast local probe. Everything else (cameras, Zigbee sub-devices -
  // sleep between reports, so a strict online flag makes them look broken most of the time, see
  // docs/plans/tuya-panel.md Phase 3) is shown as "data updated so-and-so long ago" instead.
  if (device.hasLocalKey && !CLOUD_ONLY_CATEGORIES.has(device.category)) {
    return {
      dotClass: device.online ? 'dot-ok' : 'dot-error',
      text: device.online ? t('tuya.online') : t('tuya.offline')
    }
  }
  if (!device.dpsUpdatedAt) return { dotClass: 'dot-unknown', text: t('tuya.neverSeen') }
  const fresh = Date.now() - new Date(device.dpsUpdatedAt).getTime() < STALE_AFTER_MS
  return {
    dotClass: fresh ? 'dot-ok' : 'dot-unknown',
    text: t('tuya.lastSeen', { when: fmtDateTime(device.dpsUpdatedAt) })
  }
}

function isOffline (device) {
  return statusInfo(device).dotClass !== 'dot-ok'
}

// --- readings (read-only DPS) ---

function renderReadings (device) {
  const functionCodes = new Set((device.schema.functions || []).map((f) => f.code))
  const readOnly = (device.schema.status || []).filter((s) => {
    if (functionCodes.has(s.code)) return false
    const value = device.dps ? device.dps[s.code] : undefined
    // Skip anything that's clearly not a human reading (a base64 snapshot, an event payload, etc.) -
    // by length, not by field name, so a device/category this codebase hasn't seen yet is covered too.
    return value === undefined || value === null || String(value).length <= MAX_READING_VALUE_LENGTH
  })
  if (!readOnly.length) return null

  const box = document.createElement('div')
  box.className = 'tuya-readings'
  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = t('tuya.sensorDataTitle')
  box.appendChild(title)

  const row = document.createElement('div')
  row.className = 'job-form-row'
  readOnly.forEach((item) => {
    const chip = document.createElement('span')
    chip.className = 'state-badge state-other'
    const text = `${dpLabel(item.code)}: ${formatDpsValue(item, device.dps ? device.dps[item.code] : undefined)}`
    chip.textContent = text
    chip.title = text // full text on hover, in case the CSS ellipsis truncated it
    row.appendChild(chip)
  })
  box.appendChild(row)
  return box
}

// --- camera snapshot (Phase 13) ---

function buildSnapshotSection (device) {
  const box = document.createElement('div')
  box.className = 'tuya-snapshot-section'
  const btn = actionButton(t('tuya.snapshotBtn'), 'btn-secondary', async () => {
    btn.disabled = true
    const old = box.querySelector('img, .tuya-snapshot-placeholder')
    if (old) old.remove()
    const status = document.createElement('p')
    status.className = 'tuya-snapshot-placeholder'
    status.textContent = t('tuya.snapshotLoading')
    box.appendChild(status)
    try {
      const data = await apiCall(`/api/tuya/devices/${device.id}/snapshot`, { method: 'POST' })
      status.remove()
      const img = document.createElement('img')
      img.className = 'tuya-snapshot-img'
      img.src = data.imageUrl
      img.alt = device.name
      box.appendChild(img)
    } catch (err) {
      status.textContent = t('tuya.snapshotFailed', { error: err.message })
    } finally {
      btn.disabled = false
    }
  })
  box.appendChild(btn)
  return box
}

// --- device modal (Phase 11) ---

function buildModalBody (device, onRefresh) {
  const wrap = document.createElement('div')

  const statusRow = document.createElement('div')
  statusRow.className = 'job-status-row'
  const { dotClass, text } = statusInfo(device)
  const dot = document.createElement('span')
  dot.className = `dot ${dotClass}`
  const statusText = document.createElement('span')
  statusText.className = 'card-sub'
  statusText.textContent = text
  const refreshBtn = actionButton(t('tuya.refreshBtn'), 'btn-secondary', async () => {
    refreshBtn.disabled = true
    await onRefresh()
  })
  statusRow.append(dot, statusText, refreshBtn)
  wrap.appendChild(statusRow)

  if (device.category === 'sp') wrap.appendChild(buildSnapshotSection(device))

  const functions = device.schema.functions || []
  const primary = primaryFunction(device)
  const secondary = functions.filter((f) => f !== primary)
  if (functions.length) {
    const controlsTitle = document.createElement('div')
    controlsTitle.className = 'card-title tuya-controls-title'
    controlsTitle.textContent = t('tuya.controlsTitle')
    wrap.appendChild(controlsTitle)
    if (primary) wrap.appendChild(renderControl(device, primary))
    if (secondary.length) {
      const details = document.createElement('details')
      details.className = 'tuya-advanced'
      const summary = document.createElement('summary')
      summary.textContent = t('tuya.advancedTitle')
      details.appendChild(summary)
      secondary.forEach((fn) => details.appendChild(renderControl(device, fn)))
      wrap.appendChild(details)
    }
  } else {
    const empty = document.createElement('p')
    empty.className = 'empty-row'
    empty.textContent = t('tuya.noControls')
    wrap.appendChild(empty)
  }

  const readings = renderReadings(device)
  if (readings) wrap.appendChild(readings)

  const mgmtRow = document.createElement('div')
  mgmtRow.className = 'job-form-row'
  mgmtRow.style.marginTop = '14px'
  mgmtRow.appendChild(actionButton(t('tuya.renameBtn'), 'btn-secondary', () => renameDeviceUI(device)))
  mgmtRow.appendChild(actionButton(device.hidden ? t('tuya.unhideBtn') : t('tuya.hideBtn'), 'btn-secondary', () => toggleHiddenUI(device)))
  mgmtRow.appendChild(actionButton(t('tuya.removeBtn'), 'btn-remove', () => removeDeviceUI(device)))
  wrap.appendChild(mgmtRow)

  return wrap
}

function openDeviceModal (device) {
  let current = device
  const bodyWrap = document.createElement('div')

  function rerender () {
    bodyWrap.innerHTML = ''
    bodyWrap.appendChild(buildModalBody(current, doRefresh))
  }
  async function doRefresh () {
    await refreshDeviceUI(current, (fresh) => { current = fresh; rerender() })
  }

  rerender()
  openModal({ title: current.name, body: bodyWrap })
}

// --- compact device card (Phase 11) ---

function renderDeviceCard (device) {
  const card = document.createElement('div')
  card.className = 'panel tuya-device-card'

  const titleWrap = document.createElement('div')
  titleWrap.className = 'tuya-device-card-title'
  const h3 = document.createElement('h3')
  h3.textContent = device.name
  const statusRow = document.createElement('div')
  statusRow.className = 'job-status-row'
  const { dotClass, text } = statusInfo(device)
  const dot = document.createElement('span')
  dot.className = `dot ${dotClass}`
  const statusText = document.createElement('span')
  statusText.className = 'card-sub'
  statusText.textContent = text
  statusRow.append(dot, statusText)
  if (device.hidden) {
    const badge = document.createElement('span')
    badge.className = 'state-badge state-other'
    badge.textContent = t('tuya.hiddenBadge')
    statusRow.appendChild(badge)
  }
  titleWrap.append(h3, statusRow)
  card.appendChild(titleWrap)

  const footer = document.createElement('div')
  footer.className = 'tuya-device-card-footer'
  const primary = primaryFunction(device)
  if (primary) {
    const toggle = renderBooleanControl(device, primary, device.dps ? device.dps[primary.code] : undefined)
    toggle.classList.add('tuya-device-card-primary')
    footer.appendChild(toggle)
  }
  footer.appendChild(actionButton(t('tuya.detailsBtn'), 'btn-secondary', () => openDeviceModal(device)))
  card.appendChild(footer)

  return card
}

function renderDevices (devices) {
  const visible = hideOffline ? devices.filter((d) => !isOffline(d)) : devices

  if (visible.length === 0) {
    container.innerHTML = `<p class="empty-row">${devices.length ? t('tuya.allOfflineHidden') : t('tuya.none')}</p>`
    return
  }

  const byCategory = new Map()
  visible.forEach((d) => {
    const key = d.category || '?'
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key).push(d)
  })

  container.innerHTML = ''
  ;[...byCategory.entries()]
    .sort((a, b) => categoryLabel(a[0]).localeCompare(categoryLabel(b[0])))
    .forEach(([category, list]) => {
      const group = document.createElement('div')
      group.className = 'tuya-category-group'
      const heading = document.createElement('h3')
      heading.className = 'tuya-category-heading'
      heading.textContent = categoryLabel(category)
      group.appendChild(heading)
      const grid = document.createElement('div')
      grid.className = 'tuya-device-grid'
      list.sort((a, b) => a.name.localeCompare(b.name)).forEach((d) => grid.appendChild(renderDeviceCard(d)))
      group.appendChild(grid)
      container.appendChild(group)
    })
}

async function fetchDevices () {
  try {
    const data = await apiCall(`/api/tuya/devices${showHidden ? '?includeHidden=1' : ''}`)
    latestDevices = data.devices
    renderDevices(data.devices)
    refreshAutomationDevicePickers()
  } catch {
    // a transient fetch failure just leaves the last rendered state up rather than blanking the screen
  }
}

async function fetchStatus () {
  try {
    const data = await apiCall('/api/tuya/status')
    const notConfigured = document.getElementById('tuya-not-configured')
    const toolbar = document.getElementById('tuya-toolbar')
    const automationsPanel = document.getElementById('tuya-automations-panel')
    notConfigured.classList.toggle('hidden', data.configured)
    toolbar.classList.toggle('hidden', !data.configured)
    container.classList.toggle('hidden', !data.configured)
    automationsPanel.classList.toggle('hidden', !data.configured)
    if (data.configured) {
      fetchDevices()
      fetchRules()
    }
  } catch {
  }
}

// ============================================================================
// Automations (Phase 14)
// ============================================================================

let automationEls = null

function deviceNameById (id) {
  const device = latestDevices.find((d) => d.id === id)
  return device ? device.name : id
}

function populateSelect (select, options, placeholderKey) {
  const current = select.value
  select.innerHTML = ''
  if (placeholderKey) {
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = t(placeholderKey)
    select.appendChild(placeholder)
  }
  options.forEach(({ value, label }) => {
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    select.appendChild(o)
  })
  if ([...select.options].some((o) => o.value === current)) select.value = current
}

function refreshAutomationDevicePickers () {
  if (!automationEls) return
  populateSelect(
    automationEls.triggerDevice,
    latestDevices.map((d) => ({ value: d.id, label: d.name })),
    'automations.selectDevice'
  )
}

function updateTriggerCodeOptions () {
  const device = latestDevices.find((d) => d.id === automationEls.triggerDevice.value)
  const codes = deviceAllCodes(device)
  populateSelect(
    automationEls.triggerCode,
    codes.map((c) => ({ value: c.code, label: dpLabel(c.code) })),
    'automations.selectReading'
  )
  automationEls.triggerCode.disabled = !codes.length
  updateTriggerValueField()
}

function updateTriggerValueField () {
  const wrap = automationEls.triggerValueWrap
  wrap.innerHTML = ''
  const device = latestDevices.find((d) => d.id === automationEls.triggerDevice.value)
  const item = deviceAllCodes(device).find((c) => c.code === automationEls.triggerCode.value)
  automationEls.triggerValueField = renderValueField(item)
  wrap.appendChild(automationEls.triggerValueField.el)
}

function renderActionRow () {
  const row = document.createElement('div')
  row.className = 'job-run job-form tuya-automation-action-row'

  const header = document.createElement('div')
  header.className = 'job-run-header'
  const typeSelect = document.createElement('select')
  ;[['tuya_command', t('automations.actionType.tuyaCommand')], ['telegram', t('automations.actionType.telegram')]]
    .forEach(([value, label]) => {
      const o = document.createElement('option')
      o.value = value
      o.textContent = label
      typeSelect.appendChild(o)
    })
  const removeBtn = actionButton(t('automations.removeActionBtn'), 'btn-remove', () => row.remove())
  header.append(typeSelect, removeBtn)

  const fieldsWrap = document.createElement('div')
  fieldsWrap.className = 'job-form-row'

  function renderFields () {
    fieldsWrap.innerHTML = ''
    if (typeSelect.value === 'tuya_command') {
      const deviceSelect = document.createElement('select')
      populateSelect(deviceSelect, latestDevices.map((d) => ({ value: d.id, label: d.name })), null)

      const codeSelect = document.createElement('select')
      const valueWrap = document.createElement('span')
      let valueField = null

      function populateCodes () {
        const device = latestDevices.find((d) => d.id === deviceSelect.value)
        populateSelect(codeSelect, (device ? device.schema.functions || [] : []).map((f) => ({ value: f.code, label: dpLabel(f.code) })), null)
        renderValue()
      }
      function renderValue () {
        valueWrap.innerHTML = ''
        const device = latestDevices.find((d) => d.id === deviceSelect.value)
        const item = (device ? device.schema.functions || [] : []).find((f) => f.code === codeSelect.value)
        valueField = renderValueField(item)
        valueWrap.appendChild(valueField.el)
      }

      deviceSelect.addEventListener('change', populateCodes)
      codeSelect.addEventListener('change', renderValue)
      populateCodes()

      fieldsWrap.append(deviceSelect, codeSelect, valueWrap)
      row.getAction = () => ({ type: 'tuya_command', deviceId: deviceSelect.value, code: codeSelect.value, value: valueField.getValue() })
    } else {
      const chatInput = document.createElement('input')
      chatInput.type = 'text'
      chatInput.placeholder = t('automations.chatIdPlaceholder')
      const msgInput = document.createElement('input')
      msgInput.type = 'text'
      msgInput.placeholder = t('automations.messagePlaceholder')
      fieldsWrap.append(chatInput, msgInput)
      row.getAction = () => ({ type: 'telegram', chatId: chatInput.value.trim(), message: msgInput.value.trim() })
    }
  }

  typeSelect.addEventListener('change', renderFields)
  renderFields()

  row.append(header, fieldsWrap)
  return row
}

function renderRule (rule) {
  const box = document.createElement('div')
  box.className = 'job-run'

  const header = document.createElement('div')
  header.className = 'job-run-header'
  const badge = document.createElement('span')
  badge.className = `state-badge ${rule.enabled ? 'state-running' : 'state-other'}`
  badge.textContent = rule.enabled ? t('automations.enabledBadge') : t('tasks.job.paused')
  const name = document.createElement('span')
  name.className = 'card-sub'
  name.textContent = rule.name
  header.append(badge, name)
  box.appendChild(header)

  const desc = document.createElement('div')
  desc.className = 'card-sub'
  desc.textContent = t('automations.ruleDesc', {
    device: deviceNameById(rule.triggerDeviceId),
    code: dpLabel(rule.triggerCode),
    value: valueLabel(rule.triggerValue)
  })
  box.appendChild(desc)

  const actionsSummary = document.createElement('div')
  actionsSummary.className = 'card-sub'
  actionsSummary.textContent = t('automations.actionsSummary', { n: rule.actions.length })
  box.appendChild(actionsSummary)

  if (rule.lastRun) {
    const lastRunRow = document.createElement('div')
    lastRunRow.className = 'card-sub'
    lastRunRow.textContent = `${rule.lastRun.ok ? t('tasks.job.success') : t('tasks.job.failed')} · ${fmtDateTime(rule.lastRun.ranAt)}`
    box.appendChild(lastRunRow)
  }

  const actionsRow = document.createElement('div')
  actionsRow.className = 'job-form-row'
  actionsRow.appendChild(actionButton(
    rule.enabled ? t('tasks.job.pause') : t('tasks.job.resume'),
    rule.enabled ? 'btn-restart' : 'btn-start',
    async () => {
      try {
        await apiCall(`/api/automations/rules/${rule.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !rule.enabled })
        })
        fetchRules()
      } catch (err) {
        showActionResult(false, t('automations.updateFailed', { error: err.message }))
      }
    }
  ))
  actionsRow.appendChild(actionButton(t('tasks.job.runNow'), 'btn-logs', async () => {
    try {
      await apiCall(`/api/automations/rules/${rule.id}/run`, { method: 'POST' })
      showActionResult(true, t('automations.ranOk', { name: rule.name }))
      fetchRules()
    } catch (err) {
      showActionResult(false, t('automations.runFailed', { error: err.message }))
    }
  }))
  actionsRow.appendChild(actionButton(t('tasks.job.delete'), 'btn-remove', async () => {
    if (!confirm(t('automations.confirmDelete', { name: rule.name }))) return
    try {
      await apiCall(`/api/automations/rules/${rule.id}`, { method: 'DELETE' })
      showActionResult(true, t('automations.deletedOk', { name: rule.name }))
      fetchRules()
    } catch (err) {
      showActionResult(false, t('automations.deleteFailed', { error: err.message }))
    }
  }))
  box.appendChild(actionsRow)

  return box
}

function renderRules (rules) {
  const list = document.getElementById('automation-rules-list')
  if (!rules.length) {
    list.innerHTML = `<p class="empty-row">${t('automations.none')}</p>`
    return
  }
  list.innerHTML = ''
  rules.forEach((rule) => list.appendChild(renderRule(rule)))
}

async function fetchRules () {
  try {
    const data = await apiCall('/api/automations/rules')
    renderRules(data.rules)
  } catch {
  }
}

function initAutomationsForm () {
  automationEls = {
    form: document.getElementById('automation-form'),
    name: document.getElementById('automation-name'),
    triggerDevice: document.getElementById('automation-trigger-device'),
    triggerCode: document.getElementById('automation-trigger-code'),
    triggerValueWrap: document.getElementById('automation-trigger-value-wrap'),
    triggerValueField: null,
    actionsList: document.getElementById('automation-actions-list'),
    addActionBtn: document.getElementById('automation-add-action-btn'),
    error: document.getElementById('automation-form-error')
  }

  automationEls.triggerDevice.addEventListener('change', updateTriggerCodeOptions)
  automationEls.triggerCode.addEventListener('change', updateTriggerValueField)
  automationEls.addActionBtn.addEventListener('click', () => {
    automationEls.actionsList.appendChild(renderActionRow())
  })

  automationEls.form.addEventListener('submit', async (event) => {
    event.preventDefault()
    automationEls.error.classList.add('hidden')

    const actionRows = [...automationEls.actionsList.children]
    const actions = actionRows.map((row) => row.getAction())

    const body = {
      name: automationEls.name.value.trim(),
      triggerDeviceId: automationEls.triggerDevice.value,
      triggerCode: automationEls.triggerCode.value,
      triggerValue: automationEls.triggerValueField ? automationEls.triggerValueField.getValue() : '',
      actions
    }

    try {
      const data = await apiCall('/api/automations/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      showActionResult(true, t('automations.savedOk', { name: data.rule.name }))
      automationEls.form.reset()
      automationEls.actionsList.innerHTML = ''
      updateTriggerCodeOptions()
      fetchRules()
    } catch (err) {
      automationEls.error.textContent = err.message
      automationEls.error.classList.remove('hidden')
    }
  })
}

// --- init ---

function loadHideOfflinePref () {
  try {
    const raw = localStorage.getItem(HIDE_OFFLINE_KEY)
    return raw === null ? true : raw === '1'
  } catch {
    return true
  }
}

function init () {
  container = document.getElementById('tuya-devices-container')
  hideOffline = loadHideOfflinePref()
  document.getElementById('tuya-hide-offline').checked = hideOffline

  document.getElementById('tuya-sync-btn').addEventListener('click', async (event) => {
    const btn = event.currentTarget
    btn.disabled = true
    try {
      const data = await apiCall('/api/tuya/sync', { method: 'POST' })
      showActionResult(true, t('settings.tuya.syncResult', data))
      fetchDevices()
    } catch (err) {
      showActionResult(false, t('settings.tuya.syncFailed', { error: err.message }))
    } finally {
      btn.disabled = false
    }
  })

  document.getElementById('tuya-show-hidden').addEventListener('change', (event) => {
    showHidden = event.target.checked
    fetchDevices()
  })

  document.getElementById('tuya-hide-offline').addEventListener('change', (event) => {
    hideOffline = event.target.checked
    try { localStorage.setItem(HIDE_OFFLINE_KEY, hideOffline ? '1' : '0') } catch { /* private mode etc - just don't persist */ }
    renderDevices(latestDevices)
  })

  initAutomationsForm()

  fetchStatus()
  setInterval(fetchDevices, POLL_INTERVAL_MS)

  window.addEventListener('pd-lang-changed', () => {
    fetchStatus()
  })
}

defineView('pd-view-tuya', TEMPLATE_URL, init)
