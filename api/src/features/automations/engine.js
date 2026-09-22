// Trigger evaluation for automation rules (docs/plans/tuya-panel.md Phase 14, extended in Phase 18).
// Two independent sources feed the same evaluation logic:
//
// - The poll tick (every 15s by default) - reads features/tuya/poller.js's cache, same shape as
//   features/system/health-watch.js (poll → diff against the previous read → act only on a
//   transition). Works for any device, but is only ever as fresh as the Tuya cloud tick underneath it
//   (~30s) - which stacks with this tick's own interval, up to ~45s worst case.
// - Local gateway push (features/tuya/gateway.js) - for Zigbee sub-devices specifically (door/window
//   sensors etc.), a persistent local connection to their gateway delivers a real state change within
//   seconds, with **no internet involved at all**. Only covers what gateway.js's LOCAL_DPS_CODE_MAP
//   actually maps (currently just door/window contact sensors) - everything else still relies on the
//   poll tick above.
import { createLogger } from '../../lib/logger.js'
import * as store from './store.js'
import { getCachedDps } from '../tuya/poller.js'
import { getDecryptedConfig, listDevices as listTuyaDevices, getDevice as getTuyaDevice } from '../tuya/store.js'
import { sendCommand } from '../tuya/cloud.js'
import { getDecryptedBotToken } from '../notifications/store.js'
import { sendTelegramMessage } from '../notifications/telegram.js'
import * as gateway from '../tuya/gateway.js'

const log = createLogger('automations-engine')
const TICK_MS = Number(process.env.AUTOMATIONS_POLL_INTERVAL_MS) || 15_000

// deviceId:code -> last value seen, only for pairs at least one rule currently watches. Shared across
// both trigger sources (poll and local push) and across rules watching the same pair on purpose - it's
// the same physical data point either way, whichever source noticed it first "wins" the baseline.
const previousValues = new Map()
let timer = null
let tickRunning = false
let localChangeRegistered = false

async function runAction (action) {
  if (action.type === 'tuya_command') {
    const config = getDecryptedConfig()
    if (!config) throw new Error('Tuya not configured')
    await sendCommand(config, action.deviceId, [{ code: action.code, value: action.value }])
    return `tuya_command ${action.deviceId}.${action.code}=${JSON.stringify(action.value)} ok`
  }
  if (action.type === 'telegram') {
    const token = getDecryptedBotToken()
    if (!token) throw new Error('Telegram bot not configured')
    const result = await sendTelegramMessage(token, action.chatId, action.message)
    if (!result.ok) throw new Error(result.error || 'send failed')
    return `telegram to …${String(action.chatId).slice(-4)} ok`
  }
  throw new Error(`unknown action type "${action.type}"`)
}

async function runRule (rule) {
  const details = []
  let ok = true
  for (const action of rule.actions) {
    try {
      details.push(await runAction(action))
    } catch (err) {
      ok = false
      details.push(`${action.type} failed: ${err.message}`)
    }
  }
  store.recordRun(rule.id, ok, details.join('; '))
  log.info(`regra "${rule.name}" disparada${ok ? '' : ' (com falha em alguma ação)'}: ${details.join('; ')}`)
}

// Shared by the poll tick and the local-push handler below - same debounce discipline
// features/system/health-watch.js already uses: fire only on the transition, never again while the
// value stays the same, never on the very first read for a given pair (that one only seeds the
// baseline). `rules` is pre-filtered to the ones actually watching this exact (deviceId, code) pair.
function evaluateChange (rules, deviceId, code, newValue) {
  const key = `${deviceId}:${code}`
  const hadPrevious = previousValues.has(key)
  const previous = previousValues.get(key)
  previousValues.set(key, newValue)

  if (!hadPrevious) return // first read for this pair just seeds the baseline
  if (String(newValue) === String(previous)) return // no change - nothing to evaluate

  for (const rule of rules) {
    if (rule.triggerDeviceId !== deviceId || rule.triggerCode !== code) continue
    if (String(newValue) !== rule.triggerValue) continue // changed, but not to the value this rule cares about
    runRule(rule).catch((err) => log.error(`falha ao rodar a regra "${rule.name}"`, err.message))
  }
}

async function tick () {
  if (tickRunning) return
  tickRunning = true
  try {
    const rules = store.listEnabledRulesRaw()
    for (const rule of rules) {
      const cached = getCachedDps(rule.triggerDeviceId)
      if (!cached || cached.values[rule.triggerCode] === undefined) continue
      evaluateChange(rules, rule.triggerDeviceId, rule.triggerCode, cached.values[rule.triggerCode])
    }
    await updateGatewayListeners()
  } finally {
    tickRunning = false
  }
}

// Local push delivery (features/tuya/gateway.js) - registered once, reuses the exact same
// evaluateChange() the poll tick uses, just fed from a different source. A door sensor's push arrives
// here within seconds of the real event, not up to ~45s later via the poll path.
function handleLocalChange (deviceId, code, value) {
  const rules = store.listEnabledRulesRaw()
  evaluateChange(rules, deviceId, code, value)
}

// Starts/stops local gateway connections (features/tuya/gateway.js) to match what's actually needed
// right now - only gateways with at least one sub-device an *enabled* rule is watching, per the user's
// own call on this (docs/plans/tuya-panel.md Phase 18): not every Zigbee sensor, all the time.
async function updateGatewayListeners () {
  const config = getDecryptedConfig()
  if (!config) return

  const rules = store.listEnabledRulesRaw()
  const needsLocalPush = rules.some((rule) => {
    const device = getTuyaDevice(rule.triggerDeviceId)
    return device && !device.hasLocalKey && gateway.isLocallyTriggerable(device.category)
  })

  const gatewayIds = listTuyaDevices({ includeHidden: true })
    .filter((d) => d.category === 'wg2')
    .map((d) => d.id)

  if (needsLocalPush) {
    await Promise.all(gatewayIds.map((id) => gateway.ensureListening(config, id).catch((err) => log.error(`gateway ${id} falhou`, err.message))))
  } else {
    gatewayIds.forEach((id) => gateway.stopListening(id))
  }
}

export async function runRuleNow (ruleId) {
  const rule = store.getRule(ruleId)
  if (!rule) return null
  await runRule(rule)
  return store.getRule(ruleId)
}

export function startAutomationsEngine () {
  if (timer) return
  if (!localChangeRegistered) {
    gateway.onLocalChange(handleLocalChange)
    localChangeRegistered = true
  }
  timer = setInterval(() => { tick().catch((err) => log.error('tick falhou', err.message)) }, TICK_MS)
  tick().catch((err) => log.error('tick inicial falhou', err.message))
  log.info(`motor de automações iniciado (a cada ${TICK_MS}ms, mais push local pra sensores Zigbee elegíveis)`)
}
