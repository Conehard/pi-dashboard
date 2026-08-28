import { PassThrough } from 'stream'
import { docker } from '../../lib/docker-client.js'
import { withNotFoundHandling } from './lifecycle.js'

export async function getContainerDetails (id) {
  const container = docker.getContainer(id)
  let inspect
  try {
    inspect = await container.inspect()
  } catch (err) {
    return withNotFoundHandling(err)
  }

  const labels = inspect.Config.Labels || {}
  const command = [...(inspect.Config.Entrypoint || []), ...(inspect.Config.Cmd || [])]

  return {
    id: inspect.Id.slice(0, 12),
    name: inspect.Name.replace(/^\//, ''),
    image: inspect.Config.Image,
    command: command.length ? command.join(' ') : null,
    created: inspect.Created,
    state: inspect.State,
    restartPolicy: (inspect.HostConfig && inspect.HostConfig.RestartPolicy) || null,
    env: inspect.Config.Env || [],
    labels,
    ports: inspect.NetworkSettings.Ports || {},
    mounts: (inspect.Mounts || []).map(m => ({
      source: m.Source,
      destination: m.Destination,
      mode: m.Mode,
      rw: m.RW,
      type: m.Type
    })),
    networks: Object.keys(inspect.NetworkSettings.Networks || {}),
    composeProject: labels['com.docker.compose.project'] || null,
    composeService: labels['com.docker.compose.service'] || null
  }
}

export async function streamContainerLogs (id, { tail = 200 } = {}) {
  const container = docker.getContainer(id)
  try {
    await container.inspect()
  } catch (err) {
    return withNotFoundHandling(err)
  }

  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail,
    timestamps: true
  })

  return stream
}

export function demuxToLines (stream, onLine) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let buffer = ''

  const feed = (chunk) => {
    buffer += chunk.toString('utf8')
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (line.length) onLine(line)
    }
  }

  stdout.on('data', feed)
  stderr.on('data', feed)
  docker.modem.demuxStream(stream, stdout, stderr)
}
