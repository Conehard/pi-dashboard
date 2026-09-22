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

// Unused images + the build cache. The build cache is what actually fills the SD card on this host: it
// keeps the intermediate layers of every `docker compose up --build`, is never cleaned automatically,
// and had grown to ~38GB here. It's pure cache - the only cost of removing it is that the next build of
// each project starts from scratch. Build cache prune runs in passes: with the containerd image store,
// one pass only frees "private" records, and layers shared between records only become reclaimable
// after the records sharing them are gone (confirmed by hand: 1st pass freed ~3.9GB, leaving ~34GB
// "shared, reclaimable"). Stops once a pass frees nothing (or after MAX_BUILD_CACHE_PASSES).
const MAX_BUILD_CACHE_PASSES = 5

export async function pruneImages () {
  try {
    const images = await docker.pruneImages({ filters: { dangling: ['false'] } })
    let buildCacheBytes = 0
    for (let pass = 0; pass < MAX_BUILD_CACHE_PASSES; pass++) {
      const result = await docker.pruneBuilder({ all: true })
      const freed = result.SpaceReclaimed || 0
      buildCacheBytes += freed
      if (freed === 0) break
    }
    const summary = {
      imagesDeleted: (images.ImagesDeleted || []).length,
      spaceReclaimedBytes: (images.SpaceReclaimed || 0) + buildCacheBytes,
      buildCacheBytes
    }
    logAudit('docker.prune', { detail: `${summary.imagesDeleted} imagem(ns) + ${buildCacheBytes} bytes de cache de build, ${summary.spaceReclaimedBytes} bytes no total` })
    return summary
  } catch (err) {
    throw new ActionError('err.pruneFailed', 500, { error: err.message })
  }
}
