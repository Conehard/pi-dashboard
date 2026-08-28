import { docker } from '../../lib/docker-client.js'
import { ActionError } from '../../lib/errors.js'
import { logAudit } from '../audit/audit.js'
import { startContainer, stopContainer, restartContainer } from './lifecycle.js'

const PROJECT_ACTIONS = {
  start: startContainer,
  stop: stopContainer,
  restart: restartContainer
}

export async function actOnProject (project, action) {
  const fn = PROJECT_ACTIONS[action]
  if (!fn) {
    throw new ActionError('err.invalidProjectAction', 400, { action })
  }

  const list = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`] })
  })

  if (list.length === 0) {
    throw new ActionError('err.noContainerForProject', 404, { project })
  }

  const results = await Promise.all(list.map(async (info) => {
    const fallbackName = info.Names[0].replace(/^\//, '')
    try {
      const result = await fn(info.Id)
      return { name: result.name, ok: true }
    } catch (err) {
      return { name: fallbackName, ok: false, error: err.message }
    }
  }))

  return { project, action, results }
}

export async function pruneImages () {
  try {
    const result = await docker.pruneImages({ filters: { dangling: ['false'] } })
    const summary = {
      imagesDeleted: (result.ImagesDeleted || []).length,
      spaceReclaimedBytes: result.SpaceReclaimed || 0
    }
    logAudit('docker.prune', { detail: `${summary.imagesDeleted} imagem(ns), ${summary.spaceReclaimedBytes} bytes` })
    return summary
  } catch (err) {
    throw new ActionError('err.pruneFailed', 500, { error: err.message })
  }
}
