import { docker } from '../../lib/docker-client.js'
import { ActionError } from '../../lib/errors.js'
import { createLogger } from '../../lib/logger.js'
import { logAudit } from '../audit/audit.js'

const log = createLogger('docker-actions')

const SELF_CONTAINER_NAMES = new Set(['pi-dashboard-api', 'pi-dashboard-web'])

export async function getContainerName (container) {
  const inspect = await container.inspect()
  return inspect.Name.replace(/^\//, '')
}

export async function assertNotSelf (container) {
  const name = await getContainerName(container)
  if (SELF_CONTAINER_NAMES.has(name)) {
    throw new ActionError('err.selfManagedContainer', 403, { name })
  }
  return name
}

export function withNotFoundHandling (err) {
  if (err.statusCode === 404) {
    throw new ActionError('err.containerNotFound', 404)
  }
  throw err instanceof ActionError ? err : new ActionError(err.message, 500)
}

export async function startContainer (id) {
  const container = docker.getContainer(id)
  try {
    const name = await assertNotSelf(container)
    await container.start()
    log.info(`started ${name}`)
    logAudit('container.start', { target: name })
    return { name, action: 'start' }
  } catch (err) {
    return withNotFoundHandling(err)
  }
}

export async function stopContainer (id) {
  const container = docker.getContainer(id)
  try {
    const name = await assertNotSelf(container)
    await container.stop({ t: 10 })
    log.info(`stopped ${name}`)
    logAudit('container.stop', { target: name })
    return { name, action: 'stop' }
  } catch (err) {
    if (err.statusCode === 304) {
      const name = await getContainerName(container)
      return { name, action: 'stop' }
    }
    return withNotFoundHandling(err)
  }
}

export async function restartContainer (id) {
  const container = docker.getContainer(id)
  try {
    const name = await assertNotSelf(container)
    await container.restart({ t: 10 })
    log.info(`restarted ${name}`)
    logAudit('container.restart', { target: name })
    return { name, action: 'restart' }
  } catch (err) {
    return withNotFoundHandling(err)
  }
}

export async function pauseContainer (id) {
  const container = docker.getContainer(id)
  try {
    const name = await assertNotSelf(container)
    await container.pause()
    log.info(`paused ${name}`)
    logAudit('container.pause', { target: name })
    return { name, action: 'pause' }
  } catch (err) {
    return withNotFoundHandling(err)
  }
}

export async function unpauseContainer (id) {
  const container = docker.getContainer(id)
  try {
    const name = await assertNotSelf(container)
    await container.unpause()
    log.info(`unpaused ${name}`)
    logAudit('container.unpause', { target: name })
    return { name, action: 'unpause' }
  } catch (err) {
    return withNotFoundHandling(err)
  }
}

export async function removeContainer (id) {
  const container = docker.getContainer(id)
  try {
    const name = await assertNotSelf(container)
    const inspect = await container.inspect()
    if (inspect.State && (inspect.State.Running || inspect.State.Paused)) {
      throw new ActionError('err.containerRunningCannotRemove', 409, { name })
    }
    await container.remove({})
    log.info(`removed ${name}`)
    logAudit('container.remove', { target: name })
    return { name, action: 'remove' }
  } catch (err) {
    return withNotFoundHandling(err)
  }
}

export function pullImage (image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err)
      docker.modem.followProgress(stream, (progressErr) => {
        if (progressErr) return reject(progressErr)
        resolve()
      })
    })
  })
}

export async function recreateContainer (id) {
  const container = docker.getContainer(id)
  let name
  try {
    name = await assertNotSelf(container)
  } catch (err) {
    return withNotFoundHandling(err)
  }

  let inspect
  try {
    inspect = await container.inspect()
  } catch (err) {
    return withNotFoundHandling(err)
  }

  const image = inspect.Config.Image
  log.info(`recreating ${name}: pulling ${image}`)

  try {
    await pullImage(image)
  } catch (err) {
    throw new ActionError('err.imagePullFailed', 502, { image, error: err.message })
  }

  try {
    if (inspect.State && inspect.State.Running) {
      await container.stop({ t: 10 }).catch((err) => {
        if (err.statusCode !== 304) throw err
      })
    }
    await container.remove({})

    const created = await docker.createContainer({
      name,
      Image: image,
      Env: inspect.Config.Env,
      Cmd: inspect.Config.Cmd,
      Entrypoint: inspect.Config.Entrypoint,
      Labels: inspect.Config.Labels,
      ExposedPorts: inspect.Config.ExposedPorts,
      HostConfig: inspect.HostConfig,
      NetworkingConfig: {
        EndpointsConfig: inspect.NetworkSettings.Networks
      }
    })
    await created.start()

    log.info(`recreated ${name} on ${image}`)
    logAudit('container.recreate', { target: name, detail: image })
    return { name, action: 'recreate', image }
  } catch (err) {
    log.error(`recreate failed for ${name}`, err.message)
    throw new ActionError('err.recreateFailed', 500, { image, error: err.message })
  }
}
