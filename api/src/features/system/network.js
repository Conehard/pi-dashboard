import fs from 'node:fs/promises'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('network')

const HOST_PROC = '/host/proc'
const HOST_NET_DEV = `${HOST_PROC}/1/net/dev`
const EXCLUDE_PREFIXES = ['lo', 'veth', 'docker', 'br-']

let lastSample = null

function shouldInclude (name) {
  return !EXCLUDE_PREFIXES.some((prefix) => name.startsWith(prefix))
}

async function readInterfaces () {
  const text = await fs.readFile(HOST_NET_DEV, 'utf8')
  const interfaces = new Map()

  for (const line of text.split('\n').slice(2)) {
    const sepIndex = line.indexOf(':')
    if (sepIndex === -1) continue

    const name = line.slice(0, sepIndex).trim()
    if (!shouldInclude(name)) continue

    const fields = line.slice(sepIndex + 1).trim().split(/\s+/).map(Number)
    const rxBytes = fields[0]
    const txBytes = fields[8]
    if (Number.isNaN(rxBytes) || Number.isNaN(txBytes)) continue

    interfaces.set(name, { rxBytes, txBytes })
  }

  return interfaces
}

export async function getNetworkSnapshot () {
  let current
  try {
    current = await readInterfaces()
  } catch (err) {
    log.error('net/dev read failed', err.message)
    return { available: false, totalRxBps: null, totalTxBps: null, interfaces: [] }
  }

  const now = Date.now()
  const prev = lastSample
  lastSample = { timestamp: now, interfaces: current }

  const interfaces = []
  let totalRxBps = 0
  let totalTxBps = 0
  let haveRates = false

  for (const [name, sample] of current) {
    let rxBps = null
    let txBps = null

    const prevSample = prev && prev.interfaces.get(name)
    if (prevSample) {
      const elapsedSeconds = (now - prev.timestamp) / 1000
      if (elapsedSeconds > 0) {
        rxBps = Math.max(0, (sample.rxBytes - prevSample.rxBytes) / elapsedSeconds)
        txBps = Math.max(0, (sample.txBytes - prevSample.txBytes) / elapsedSeconds)
        totalRxBps += rxBps
        totalTxBps += txBps
        haveRates = true
      }
    }

    interfaces.push({
      name,
      rxBps,
      txBps,
      rxTotalBytes: sample.rxBytes,
      txTotalBytes: sample.txBytes
    })
  }

  interfaces.sort((a, b) => (b.rxBps || 0) - (a.rxBps || 0))

  return {
    available: true,
    totalRxBps: haveRates ? Number(totalRxBps.toFixed(1)) : null,
    totalTxBps: haveRates ? Number(totalTxBps.toFixed(1)) : null,
    interfaces
  }
}
