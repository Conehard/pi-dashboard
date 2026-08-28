import { docker } from '../../lib/docker-client.js'
import { pullImage } from '../docker/lifecycle.js'
import { ActionError } from '../../lib/errors.js'
import { createLogger } from '../../lib/logger.js'
import { logAudit } from '../audit/audit.js'

const log = createLogger('power')

const HELPER_IMAGE = 'alpine:latest'

async function ensureImage (image) {
  try {
    await docker.getImage(image).inspect()
  } catch (err) {
    if (err.statusCode !== 404) throw err
    await pullImage(image)
  }
}

export async function rebootHost () {
  let container
  try {
    await ensureImage(HELPER_IMAGE)

    container = await docker.createContainer({
      Image: HELPER_IMAGE,
      Cmd: ['reboot', '-f'],
      HostConfig: {
        Privileged: true,
        PidMode: 'host',
        AutoRemove: true
      }
    })
    await container.start()
  } catch (err) {
    log.error('reboot failed', err.message)
    throw new ActionError('err.rebootFailed', 500, { error: err.message })
  }

  log.info('host reboot triggered')
  logAudit('system.reboot')
  return { ok: true }
}
