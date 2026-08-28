import fs from 'node:fs/promises'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('storage')

const TARGETS = [
  { label: '/', path: '/host/rootfs' },
  { label: '/mnt/touro', path: '/host/mnt/touro' }
]

async function statOne (target) {
  try {
    const stats = await fs.statfs(target.path)
    const total = stats.blocks * stats.bsize
    const free = stats.bfree * stats.bsize
    const available = stats.bavail * stats.bsize
    const used = total - free

    return {
      label: target.label,
      totalBytes: total,
      usedBytes: used,
      availableBytes: available,
      percent: total > 0 ? Number(((used / total) * 100).toFixed(1)) : null
    }
  } catch (err) {
    log.error(`failed to stat ${target.label}`, err.message)
    return { label: target.label, totalBytes: null, usedBytes: null, availableBytes: null, percent: null }
  }
}

export async function getStorageSnapshot () {
  return Promise.all(TARGETS.map(statOne))
}
